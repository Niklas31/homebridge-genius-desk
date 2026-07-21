/**
 * homebridge-genius-desk
 *
 * Dynamic platform para uma ou mais mesas de altura ajustável Tuya que:
 *   - reportam altura real em cm (DP "height")
 *   - só aceitam comando discreto up/down/stop (DP "up_down")
 *   - reportam estado do motor (DP "work_state") e falhas (DP "fault")
 *
 * Não usa DP de "percent_high" (frequentemente morto/nunca atualizado
 * pelo firmware) — trabalha direto com a altura real e converte para
 * a porcentagem que o HomeKit espera (0-100%).
 *
 * Baseado no schema descoberto via Tuya IoT Platform:
 *   dp 1  up_down      enum   ("up" | "down" | "stop")
 *   dp 2  work_state   enum   ("rising" | "falling" | "stop")
 *   dp 5  fault        bitmap (0 = sem falha)
 *   dp 8  height       value  (cm, inteiro)
 *
 * IMPORTANTE: os valores exatos do enum "up_down" (maiúsculo/minúsculo,
 * "up"/"Up"/"UP" etc.) precisam ser confirmados testando — ajuste as
 * constantes UP_DOWN_* abaixo se o log mostrar valores diferentes.
 */

'use strict';

const TuyaDevice = require('tuyapi');

const PLUGIN_NAME = 'homebridge-genius-desk';
const PLATFORM_NAME = 'GeniusDesk';

// Ajuste aqui se o log mostrar valores diferentes para o DP up_down
const UP_DOWN_UP = 'up';
const UP_DOWN_DOWN = 'down';
const UP_DOWN_STOP = 'stop';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GeniusDeskPlatform);
};

class GeniusDeskPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.hap = api.hap;
    this.config = config || {};
    this.devicesConfig = Array.isArray(this.config.devices) ? this.config.devices : [];

    // Acessórios restaurados do cache do Homebridge (chamado antes de
    // 'didFinishLaunching'), indexados por UUID.
    this.cachedAccessories = new Map();
    this.desks = [];

    if (!api) return;

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  // Chamado pelo Homebridge para cada acessório restaurado do cache em disco.
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    if (this.devicesConfig.length === 0) {
      this.log.warn('GeniusDesk: nenhuma mesa configurada em "devices" na plataforma.');
    }

    const seenUuids = new Set();

    for (const deviceConfig of this.devicesConfig) {
      const name = deviceConfig.name || 'Genius Desk';

      if (!deviceConfig.id || !deviceConfig.key) {
        this.log.error(`GeniusDesk: mesa "${name}" sem "id"/"key" no config — pulando.`);
        continue;
      }
      if (deviceConfig.minHeightCm == null || deviceConfig.maxHeightCm == null) {
        this.log.error(`GeniusDesk: mesa "${name}" sem "minHeightCm"/"maxHeightCm" no config — pulando.`);
        continue;
      }

      const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.id}`);
      seenUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        this.log.info(`GeniusDesk: registrando nova mesa "${name}"`);
        accessory = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        accessory.displayName = name;
      }

      this.desks.push(new GeniusDesk(this.log, deviceConfig, this.api, accessory));
    }

    const staleAccessories = [];
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!seenUuids.has(uuid)) {
        this.log.info(`GeniusDesk: removendo mesa não mais configurada: ${accessory.displayName}`);
        staleAccessories.push(accessory);
      }
    }
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }
}

class GeniusDesk {
  constructor(log, config, api, accessory) {
    this.log = log;
    this.api = api;
    this.hap = api.hap;
    this.accessory = accessory;

    this.name = config.name || 'Genius Desk';
    this.deviceId = config.id;
    this.localKey = config.key;
    this.ip = config.ip; // opcional — se omitido, tenta descobrir via broadcast UDP
    this.protocolVersion = config.protocolVersion || '3.4';

    this.minHeightCm = config.minHeightCm;
    this.maxHeightCm = config.maxHeightCm;
    this.toleranceCm = config.toleranceCm != null ? config.toleranceCm : 1;
    this.dpControl = String(config.dpControl || 1);
    this.dpWorkState = String(config.dpWorkState || 2);
    this.dpFault = String(config.dpFault || 5);
    this.dpHeight = String(config.dpHeight || 8);
    this.watchdogMs = config.watchdogMs || 30000; // segurança: para o motor se não convergir

    this.currentHeightCm = null;
    this.targetHeightCm = null;
    this.targetPositionPercent = null;
    this.moving = false;
    this.watchdogTimer = null;

    this.device = new TuyaDevice({
      id: this.deviceId,
      key: this.localKey,
      ip: this.ip,
      version: this.protocolVersion,
    });

    // Registrados uma única vez: o `device` vive pelo tempo todo do acessório,
    // então re-registrar esses handlers a cada connect() duplica listeners a
    // cada reconexão e vira um loop exponencial.
    this.device.on('data', (data) => this.handleData(data));

    this.device.on('disconnected', () => {
      if (this.moving) {
        this.log.warn(
          `GeniusDesk (${this.name}): desconectado com o motor em movimento — não há como confirmar o stop até reconectar, tentando reconectar...`
        );
      } else {
        this.log.warn(`GeniusDesk (${this.name}): desconectado, tentando reconectar...`);
      }
      setTimeout(() => this.connect(), 5000);
    });

    this.device.on('error', (err) => {
      this.log.error(`GeniusDesk (${this.name}): erro de conexão — ${err.message}`);
    });

    this.service =
      this.accessory.getService(this.hap.Service.WindowCovering) ||
      this.accessory.addService(this.hap.Service.WindowCovering, this.name);

    this.service
      .getCharacteristic(this.hap.Characteristic.CurrentPosition)
      .onGet(() => this.percentFromHeight(this.currentHeightCm ?? this.minHeightCm));

    this.service
      .getCharacteristic(this.hap.Characteristic.TargetPosition)
      .onGet(() => this.targetPositionPercent ?? this.percentFromHeight(this.currentHeightCm ?? this.minHeightCm))
      .onSet((value) => this.setTargetPosition(value));

    this.positionState = this.hap.Characteristic.PositionState.STOPPED;
    this.service
      .getCharacteristic(this.hap.Characteristic.PositionState)
      .onGet(() => this.positionState);

    const informationService =
      this.accessory.getService(this.hap.Service.AccessoryInformation) ||
      this.accessory.addService(this.hap.Service.AccessoryInformation);
    informationService
      .setCharacteristic(this.hap.Characteristic.Manufacturer, config.manufacturer || 'Tuya')
      .setCharacteristic(this.hap.Characteristic.Model, config.model || 'Genius Desk')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceId);

    this.connect();
  }

  // ---- conversão cm <-> % ----

  percentFromHeight(cm) {
    const pct = ((cm - this.minHeightCm) / (this.maxHeightCm - this.minHeightCm)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  heightFromPercent(pct) {
    return this.minHeightCm + ((this.maxHeightCm - this.minHeightCm) * pct) / 100;
  }

  // ---- conexão ----

  async connect() {
    try {
      if (!this.ip) {
        this.log.info(`GeniusDesk (${this.name}): procurando dispositivo na rede local...`);
        await this.device.find();
      }
      await this.device.connect();
      this.log.info(`GeniusDesk (${this.name}): conectado`);
    } catch (err) {
      this.log.error(`GeniusDesk (${this.name}): falha ao conectar, tentando novamente em 10s — ${err.message}`);
      setTimeout(() => this.connect(), 10000);
      return;
    }

    // Se a conexão caiu com o motor em movimento, não temos como saber se o
    // watchdog conseguiu parar o motor de verdade (o comando pode ter falhado
    // por falta de conexão) — manda stop de novo por segurança assim que
    // reconectar, antes de qualquer outra coisa.
    if (this.moving) {
      this.log.warn(`GeniusDesk (${this.name}): reconectado com o motor marcado como em movimento — mandando stop de segurança`);
      await this.stopMotor();
    }

    // Pede o estado atual assim que conecta
    try {
      await this.device.get({ schema: true });
    } catch (err) {
      this.log.warn(`GeniusDesk (${this.name}): não consegui buscar estado inicial — ${err.message}`);
    }
  }

  // ---- tratamento de dados recebidos do dispositivo ----

  handleData(data) {
    const dps = data.dps || {};

    if (dps[this.dpHeight] !== undefined) {
      this.currentHeightCm = dps[this.dpHeight];
      const pct = this.percentFromHeight(this.currentHeightCm);
      this.service.updateCharacteristic(this.hap.Characteristic.CurrentPosition, pct);
      this.checkArrival();
    }

    if (dps[this.dpWorkState] !== undefined) {
      const state = dps[this.dpWorkState];
      if (state === 'rising') {
        this.positionState = this.hap.Characteristic.PositionState.INCREASING;
      } else if (state === 'falling') {
        this.positionState = this.hap.Characteristic.PositionState.DECREASING;
      } else {
        this.positionState = this.hap.Characteristic.PositionState.STOPPED;
      }
      this.service.updateCharacteristic(this.hap.Characteristic.PositionState, this.positionState);
    }

    if (dps[this.dpFault] !== undefined) {
      const hasFault = dps[this.dpFault] !== 0;
      this.service.updateCharacteristic(
        this.hap.Characteristic.StatusFault,
        hasFault ? this.hap.Characteristic.StatusFault.GENERAL_FAULT : this.hap.Characteristic.StatusFault.NO_FAULT
      );
      if (hasFault) {
        this.log.warn(`GeniusDesk (${this.name}): bitmap de falha reportado (${dps[this.dpFault]}) — parando o motor por segurança`);
        this.stopMotor();
      }
    }
  }

  // ---- controle ----

  async setTargetPosition(percent) {
    this.targetPositionPercent = percent;
    this.targetHeightCm = this.heightFromPercent(percent);
    this.log.info(`GeniusDesk (${this.name}): alvo ${percent}% (~${this.targetHeightCm.toFixed(1)}cm)`);

    if (this.currentHeightCm == null) {
      this.log.warn(`GeniusDesk (${this.name}): ainda sem leitura de altura atual, ignorando comando`);
      return;
    }

    const diff = this.targetHeightCm - this.currentHeightCm;
    if (Math.abs(diff) <= this.toleranceCm) {
      await this.stopMotor();
      return;
    }

    try {
      await this.device.set({ dps: Number(this.dpControl), set: diff > 0 ? UP_DOWN_UP : UP_DOWN_DOWN });
      this.moving = true;
      this.armWatchdog();
    } catch (err) {
      this.log.error(`GeniusDesk (${this.name}): falha ao enviar comando de movimento — ${err.message}`);
    }
  }

  checkArrival() {
    if (!this.moving || this.targetHeightCm == null) return;
    const diff = this.targetHeightCm - this.currentHeightCm;
    if (Math.abs(diff) <= this.toleranceCm) {
      this.stopMotor();
    }
  }

  async stopMotor() {
    this.moving = false;
    this.clearWatchdog();

    // Stop é o comando mais crítico de segurança do plugin — tenta algumas
    // vezes antes de desistir, em vez de só logar e seguir em frente.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.device.set({ dps: Number(this.dpControl), set: UP_DOWN_STOP });
        break;
      } catch (err) {
        if (attempt === maxAttempts) {
          this.log.error(
            `GeniusDesk (${this.name}): falha ao enviar comando de stop após ${maxAttempts} tentativas — ${err.message}`
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }

    this.service.updateCharacteristic(this.hap.Characteristic.PositionState, this.hap.Characteristic.PositionState.STOPPED);
  }

  // ---- segurança: se por algum motivo não convergir, para sozinho ----

  armWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.moving) {
        this.log.warn(`GeniusDesk (${this.name}): watchdog acionado — motor não convergiu no tempo esperado, parando`);
        this.stopMotor();
      }
    }, this.watchdogMs);
  }

  clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
