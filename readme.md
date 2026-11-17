# wa-cleaner

Herramienta personal para rescatar mensajes y archivos importantes de WhatsApp a un chat de Telegram. La fase implementada lee mensajes de WhatsApp, aplica reglas configurables y los guarda en una cola local SQLite. En modo real, reenvía a Telegram los elementos de la cola que cumplen las reglas.

> **Estado actual: Fase 1 (rescate).** El programa no borra mensajes ni envía mensajes a WhatsApp. La limpieza, las reglas de conservación adicionales y la evaluación con Claude aún no están implementadas.

## Requisitos

- Node.js `>=22.13`
- Un bot de Telegram creado con [@BotFather](https://t.me/BotFather)
- WhatsApp para vincular el dispositivo mediante el QR

## Configuración

Instala las dependencias:

```sh
npm install
```

Completa `.env` con el token del bot de Telegram. Mantén `DRY_RUN=true` mientras revisas la cola. Para consultar el identificador de los chats que han escrito al bot:

```sh
npm run chatid
```

Copia el `TELEGRAM_CHAT_ID` del chat personal a `.env`. Edita `rules.json` para configurar palabras clave, extensiones de documentos, chats ignorados, opciones de “Mensajes guardados” y límites.

## Uso

```sh
npm run check
npm run community-inventory
npm run list
npm run start
npm run summary
npm run typecheck
```

- `npm run check` comprueba Telegram, envía mensajes de prueba a Telegram y conecta WhatsApp. Al recibir historial, evalúa los mensajes y guarda los que coinciden en la cola. No reenvía esos mensajes rescatados.
- `npm run community-inventory` muestra los grupos enlazados a las comunidades Tesla solicitadas y cuenta mensajes observados en el historial disponible. Es de solo lectura respecto a mensajes: no usa SQLite ni Telegram. Requiere conectar WhatsApp y guarda la sesión de vinculación en `auth/`.
- `npm run start` conecta WhatsApp y procesa la cola. Con `DRY_RUN=true`, recibe y guarda mensajes, pero no descarga medios ni envía los elementos de la cola. Para habilitar reenvíos reales, configura primero las credenciales y las reglas, revisa la cola y cambia `DRY_RUN=false`.
- `npm run summary` muestra las cantidades por estado y una muestra de los pendientes.
- `npm run list` muestra hasta 100 mensajes pendientes en una tabla; se puede consultar otro estado con `npm run list -- done`, `failed` o `skipped`.
- `npm run typecheck` ejecuta la comprobación de TypeScript.
- `npm run chatid` muestra los chats que han enviado mensajes al bot para ayudar a configurar `TELEGRAM_CHAT_ID`.

El primer vínculo puede solicitar el historial de WhatsApp. Si la aplicación está esperando progreso del historial, deja el proceso ejecutándose hasta que termine.

## Flujo y componentes

1. `src/whatsapp.ts` conecta Baileys, mantiene la sesión local, recibe eventos e historial y proporciona la descarga de medios por streaming.
2. `src/extract.ts` extrae el texto y los metadatos de mensajes de texto, imágenes, videos, audios y documentos.
3. `src/rules.ts` decide qué rescatar usando las reglas de `rules.json`.
4. `src/pipeline.ts` evalúa mensajes, los encola y, en modo real, los envía a Telegram. Los medios se limitan al menor entre el máximo configurado y 100 MB; los que superan 100 MB se omiten con una alerta visible en los logs.
5. `src/db.ts` mantiene la cola, los estados de procesamiento y los identificadores de mensajes en SQLite.
6. `src/telegram.ts` implementa el envío de texto y documentos mediante la Bot API.
7. `src/index.ts` coordina la conexión, el worker, las pausas y el límite diario.
8. `src/config.ts`, `src/utils.ts` y `src/serialize.ts` gestionan la configuración, utilidades compartidas y serialización de mensajes con campos binarios.
9. `src/check.ts`, `src/chatid.ts`, `src/community-inventory.ts`, `src/list.ts` y `src/summary.ts` implementan las utilidades de diagnóstico y consulta.

## Datos locales y seguridad

- `.env` contiene credenciales y debe mantenerse fuera del control de versiones. No compartas el token del bot.
- `auth/` contiene la sesión de WhatsApp; `data/` contiene la cola SQLite y mensajes guardados localmente. Ambos directorios están excluidos por `.gitignore`.
- La base SQLite se crea con permisos restrictivos para el usuario local. Los mensajes almacenados no están cifrados.
- `DRY_RUN=true` evita los reenvíos de la cola, pero no evita que el programa lea mensajes ni los guarde en SQLite. `npm run check` envía mensajes de prueba a Telegram incluso si `DRY_RUN=true`.

## Estructura actual

```text
.
├── src/
│   ├── check.ts
│   ├── chatid.ts
│   ├── community-inventory.ts
│   ├── config.ts
│   ├── db.ts
│   ├── extract.ts
│   ├── index.ts
│   ├── list.ts
│   ├── pipeline.ts
│   ├── rules.ts
│   ├── serialize.ts
│   ├── summary.ts
│   ├── telegram.ts
│   ├── utils.ts
│   ├── whatsapp.ts
│   ├── rules/
│   │   ├── clean.ts       # pendiente de implementación
│   │   └── keep.ts        # pendiente de implementación
│   ├── throttle.ts        # pendiente de implementación como módulo separado
│   ├── ai.ts              # pendiente de implementación
│   └── whatsapp/
│       └── adapter.ts     # pendiente de implementación
├── rules.json
├── .env                   # local; no versionar
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```