# homebridge-genius-desk

Accessory customizado para a Genius Desk (Tuya, categoria `sjz`), feito porque
o `homebridge-tuya-plus` não tem um tipo de dispositivo pra mesa de altura
com feedback real em cm + motor discreto up/down/stop.

Diferente de um `PercentBlinds` genérico, este plugin:
- Lê a altura real da mesa (DP `height`, em cm) em vez de depender de um
  DP de "percentual" que costuma ficar morto no firmware.
- Converte a posição 0–100% do HomeKit para uma altura-alvo em cm, usando
  `minHeightCm`/`maxHeightCm` que você define.
- Manda `up`/`down` e só manda `stop` quando a altura real chega perto do
  alvo (tolerância configurável) — controle em malha fechada, não por tempo.
- Tem um watchdog de segurança que para o motor se ele não convergir no
  tempo esperado (evita a mesa continuar subindo/descendo indefinidamente
  se o feedback de altura falhar).

## Instalação

1. Copie esta pasta para dentro do diretório de plugins do Homebridge, por
   exemplo:
   ```
   cp -r homebridge-genius-desk /var/lib/homebridge/node_modules/homebridge-genius-desk
   ```
   (ajuste o caminho conforme onde seu Homebridge guarda os módulos — normalmente
   ao lado de onde está instalado o `homebridge-tuya-plus`).

2. Entre na pasta copiada e instale a dependência:
   ```
   cd /var/lib/homebridge/node_modules/homebridge-genius-desk
   npm install --production
   ```

3. Reinicie o Homebridge.

## Configuração (config.json)

Se você usa o Homebridge Config UI X, o plugin já vem com `config.schema.json`
e pode ser configurado direto pela interface (basta clicar em "Settings" no
card do plugin). Os campos abaixo mostram o equivalente em JSON, caso prefira
editar o `config.json` manualmente.

Adicione um bloco em `accessories` (não em `platforms` — este é um accessory
simples, não uma plataforma):

```json
{
  "accessories": [
    {
      "accessory": "GeniusDesk",
      "name": "Genius Desk",
      "id": "eb51751f300fee3b39qyu5",
      "key": "SUA_LOCAL_KEY_AQUI",
      "ip": "IP_LOCAL_NA_SUA_REDE_OPCIONAL",
      "minHeightCm": 62,
      "maxHeightCm": 128,
      "toleranceCm": 1,
      "manufacturer": "Tuya",
      "model": "Genius Desk"
    }
  ]
}
```

### Onde conseguir cada valor

- **`id`**: já temos — `eb51751f300fee3b39qyu5`.
- **`key`** (local key): no Tuya IoT Platform → Cloud → seu projeto →
  Devices → clique no dispositivo → aba "Device Information" (ou via
  `tuya-cli wizard`, que também lista todos os dispositivos vinculados
  com sua local key).
- **`ip`**: opcional. Se você não informar, o plugin tenta descobrir
  via broadcast UDP na rede local (`device.find()` do tuyapi). Se sua
  rede bloquear broadcast (VLANs segmentadas, por exemplo), informe o IP
  fixo do dispositivo manualmente.
- **`minHeightCm` / `maxHeightCm`**: altura física mínima e máxima da
  mesa, em cm — geralmente na etiqueta do motor ou no manual. **Sem isso
  a conversão %↔cm fica errada.**

## Antes de usar de verdade: valide o enum do DP de controle

O código assume que o DP `up_down` aceita os valores `"up"`, `"down"`,
`"stop"` (minúsculo). Isso ainda não foi confirmado nos logs que você
mandou — só vimos os *nomes de exibição* "Down" e "Stop" no painel, que
podem ou não bater com o valor cru enviado por comando.

Teste rápido antes de confiar no plugin:
1. No Tuya IoT Platform → Debug Device, envie manualmente o comando no DP
   `up_down` com valor `"up"` e veja se a mesa realmente sobe.
2. Se não subir, tente `"Up"` ou `"UP"` — e ajuste as constantes
   `UP_DOWN_UP`, `UP_DOWN_DOWN`, `UP_DOWN_STOP` no topo do `index.js`.

## Limitações conhecidas

- Não implementa presets de memória (sentado/em pé) — só posicionamento
  contínuo via HomeKit.
- Não lida com child lock (DP 4) — pode ser adicionado depois como um
  `LockPhysicalControls` opcional se você quiser.
- Assume uma única mesa por instância do accessory. Para múltiplas mesas,
  duplique o bloco em `accessories` com IDs e chaves diferentes.
