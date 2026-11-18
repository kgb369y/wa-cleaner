# wa-cleaner

Herramienta personal para rescatar mensajes y archivos importantes de WhatsApp a un chat de Telegram. La fase implementada lee mensajes de WhatsApp, aplica reglas configurables y los guarda en una cola local SQLite. En modo real, reenvía a Telegram los elementos de la cola que cumplen las reglas.

> **Estado actual: Fase 1 (rescate).** El flujo principal no borra mensajes ni envía mensajes a WhatsApp. Hay comandos experimentales limitados a `WA Cleaner - PRUEBA DESTACADOS` para probar envío, borrado por ID y vaciado conservando destacados; el comportamiento de vaciado debe verificarse en WhatsApp.

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
npm run capture-history
npm run list-captured-chats -- data/history-captures/<captura>.jsonl
```

Copia el `TELEGRAM_CHAT_ID` del chat personal a `.env`. Edita `rules.json` para configurar palabras clave, extensiones de documentos, chats ignorados, opciones de “Mensajes guardados” y límites.

## Uso

```sh
npm run check
npm run community-inventory
npm run list
npm run test-clear-starred
npm run start
npm run summary
npm run test-delete-whatsapp -- <ID-del-mensaje-propio>
npm run test-send-whatsapp
npm run test:chat-pdfs
npm run test-send-telegram-pdf
npm run export-chat -- +<teléfono-internacional>
npm run process-captured-chat -- data/history-captures/<captura>.jsonl [ +<teléfono-internacional> ] [--preflight]
npm run test-download-chat-pdf -- data/history-captures/<captura>.jsonl
npm run download-chat-attachments -- +<teléfono-internacional> [data/history-captures/<captura>.jsonl] [--preflight]
npm run typecheck
```

- `npm run check` comprueba Telegram, envía mensajes de prueba a Telegram y conecta WhatsApp. Al recibir historial, evalúa los mensajes y guarda los que coinciden en la cola. No reenvía esos mensajes rescatados.
- `npm run community-inventory` consulta los grupos participantes de WhatsApp para localizar las comunidades Tesla solicitadas y mostrar solo los grupos enlazados en los que esta cuenta figura como participante, incluso si no se sincroniza historial de chats en esa ejecución; también cuenta mensajes observados en el historial disponible. Es de solo lectura respecto a mensajes: no usa SQLite ni Telegram. Requiere conectar WhatsApp y guarda la sesión de vinculación en `auth/`.
- `npm run start` conecta WhatsApp y procesa la cola. Con `DRY_RUN=true`, recibe y guarda mensajes, pero no descarga medios ni envía los elementos de la cola. Para habilitar reenvíos reales, configura primero las credenciales y las reglas, revisa la cola y cambia `DRY_RUN=false`.
- `npm run summary` muestra las cantidades por estado y una muestra de los pendientes.
- `npm run list` muestra hasta 100 mensajes pendientes en una tabla; se puede consultar otro estado con `npm run list -- done`, `failed` o `skipped`.
- `npm run typecheck` ejecuta la comprobación de TypeScript.
- `npm run chatid` muestra los chats que han enviado mensajes al bot para ayudar a configurar `TELEGRAM_CHAT_ID`.
- `npm run capture-history` conecta a WhatsApp y guarda en `data/history-captures/` todos los mensajes de los bloques de historial que WhatsApp entregue, sin aplicar `rules.json`, descargar adjuntos ni enviar a Telegram. Usa archivos locales con permisos restrictivos. No fuerza el reenvío del historial si Baileys/WhatsApp ya completó la sincronización.
- `npm run capture-history -- --fresh-link` solicita el historial al vincular una sesión nueva y separada en `data/history-capture-auth/`; no toca `auth/`. Puede recibir contenido de muchos chats para capturarlo localmente; no garantiza que WhatsApp envíe todo el archivo histórico.
- `npm run list-captured-chats -- data/history-captures/<captura>.jsonl [teléfono]` lista por separado cada chat/grupo que coincide con las palabras clave actuales de `rules.json`, con su JID, conteo de mensajes y cantidad de mensajes coincidentes. Resuelve JID/LID alternativos usando los mapeos locales de Baileys; si se indica un teléfono, limita el resultado a ese chat. Es una fase de solo lectura local: no conecta con WhatsApp/Telegram, no imprime el texto de mensajes, no descarga ni exporta archivos.
- `npm run test:chat-pdfs` prueba localmente la normalización del teléfono, la detección de PDFs y la unión de archivos deduplicados por SHA-256; no conecta a WhatsApp ni Telegram.
- `npm run test-send-telegram-pdf` envía el PDF comprimido de prueba `pdfstesting/AI_Fluency_AWS_Security_Training_gs.pdf` al `TELEGRAM_CHAT_ID` configurado. No conecta a WhatsApp ni consulta la cola; cada ejecución envía un documento nuevo.
- `npm run export-chat -- +<teléfono-internacional>` conecta a WhatsApp y exporta localmente texto, pies de foto y adjuntos reconocidos (imágenes, videos, audios, documentos y stickers) de un único chat individual. Deduplica eventos por ID, limita cada descarga al máximo del cliente y escribe en `data/chat-exports/` con permisos restrictivos. No envía datos a Telegram. Solo incluye el historial que WhatsApp entregue en esa sesión; no garantiza que el historial archivado completo esté disponible.
- `npm run process-captured-chat -- data/history-captures/<captura>.jsonl [ +<teléfono-internacional> ] [--preflight]` filtra primero un solo chat individual de una captura local, resuelve los JID/LID y después descarga únicamente sus adjuntos mediante la sesión secundaria `data/history-capture-auth/` (sin sincronizar de nuevo el historial). Une y deduplica los PDFs, intenta comprimir el resultado con Ghostscript y crea un TXT cronológico y un ZIP con el PDF combinado y los adjuntos no PDF. Si se omite el teléfono, solo continúa si encuentra una única conversación con 30 mensajes, 6 PDFs y 1 imagen. Con `--preflight` solo valida conteos locales y no conecta a WhatsApp. Los archivos se guardan localmente con permisos restrictivos; no conecta a Telegram ni envía contenido. Requiere Ghostscript y `zip` disponibles en el sistema.
- `npm run test-download-chat-pdf -- data/history-captures/<captura>.jsonl` identifica localmente el chat de prueba y, al ejecutarlo en la terminal, conecta con la sesión secundaria y solicita historial bajo demanda de ese chat en páginas de hasta 50 mensajes, avanzando desde el mensaje más reciente conocido hacia los más antiguos hasta que WhatsApp no devuelva más. No espera mensajes nuevos ni mezcla otros chats. Consolida localmente el historial aislado y descarga solo el PDF más antiguo recibido en esas páginas, verificando su cabecera antes de guardarlo en `data/chat-exports/single-pdf-test-*/first-pdf.pdf`; también guarda `chat-history.jsonl` ahí. WhatsApp puede limitar el historial disponible y no garantiza que entregue toda la conversación o sus adjuntos. El comando no envía datos a Telegram ni cambia el estado de archivado. Si la sesión necesita un QR, se detiene sin mostrarlo.
- `npm run download-chat-attachments -- +<teléfono-internacional> [data/history-captures/<captura>.jsonl] [--preflight]` es un diagnóstico aislado: usa la captura solo para encontrar el último mensaje ancla y los IDs de archivos ya conocidos, sin imprimir ni exportar texto de mensajes; después pide a WhatsApp el historial de ese chat en páginas de hasta 50 mensajes hasta agotar lo que el teléfono entregue. Inspecciona únicamente metadatos de documentos/medios de ese contacto y descarga sus adjuntos en `data/chat-exports/attachment-scan-*/`. Detecta el formato por firmas binarias, conserva los bytes originales con la extensión correspondiente y valida PDFs/archivos ZIP cuando es posible. Si Baileys no puede descifrar el medio, intenta guardar el flujo cifrado como `.enc` (no se puede abrir ni convertir ese respaldo); informa claramente errores o archivos no verificables. Con `--preflight` solo revisa los adjuntos de la captura local y no conecta con WhatsApp. Escribe un manifiesto local con permisos restrictivos y no envía contenido a Telegram. Si se omite la captura, usa la más reciente de `data/history-captures/`; requiere la sesión secundaria `data/history-capture-auth/` ya vinculada.
- `npm run test-clear-starred` vacía mensajes hasta el momento de ejecución únicamente en el grupo participante llamado exactamente `WA Cleaner - PRUEBA DESTACADOS`, usando la opción de protocolo que indica conservar destacados. Es experimental, no pide confirmación y debes comprobar el resultado en WhatsApp; no lo uses en chats reales.
- `npm run test-delete-whatsapp -- <ID-del-mensaje-propio>` solicita borrar para todos el mensaje propio indicado, únicamente en el grupo participante `WA Cleaner - PRUEBA DESTACADOS`. No pide confirmación; comprueba cuidadosamente el ID antes de usarlo. Baileys debe estar conectado y WhatsApp puede rechazar la solicitud.
- `npm run test-send-whatsapp` envía el texto fijo `prueba1` únicamente si encuentra exactamente un grupo participante llamado `WA Cleaner - PRUEBA DESTACADOS`. Todos los integrantes del grupo podrán verlo; imprime el ID del mensaje devuelto por WhatsApp para la prueba de borrado.

El primer vínculo puede solicitar el historial de WhatsApp. Si la aplicación está esperando progreso del historial, deja el proceso ejecutándose hasta que termine.

## Flujo y componentes

1. `src/whatsapp.ts` conecta Baileys, mantiene la sesión local, recibe eventos e historial y proporciona la descarga de medios por streaming.
2. `src/extract.ts` extrae el texto y los metadatos de mensajes de texto, imágenes, videos, audios y documentos.
3. `src/rules.ts` decide qué rescatar usando las reglas de `rules.json`.
4. `src/pipeline.ts` evalúa mensajes, los encola y, en modo real, los envía a Telegram. Los medios se limitan al menor entre el máximo configurado y 100 MB; los que superan 100 MB se omiten con una alerta visible en los logs.
5. `src/db.ts` mantiene la cola, los estados de procesamiento y los identificadores de mensajes en SQLite; `src/history-capture.ts` permite capturar opcionalmente los mensajes crudos del historial recibido.
6. `src/telegram.ts` implementa el envío de texto y documentos mediante la Bot API.
7. `src/index.ts` coordina la conexión, el worker, las pausas y el límite diario.
8. `src/config.ts`, `src/utils.ts` y `src/serialize.ts` gestionan la configuración, utilidades compartidas y serialización de mensajes con campos binarios.
9. `src/chat-pdfs.ts` identifica mensajes PDF de un chat individual; `src/chat-export.ts` filtra y normaliza mensajes para exportar texto y adjuntos; `src/lid-mapping.ts` resuelve aliases locales LID/teléfono; `src/matched-chats.ts` lista chats de una captura que coinciden con palabras clave; `src/pdf-merge.ts` une PDFs y omite archivos binariamente idénticos.
10. `src/check.ts`, `src/chatid.ts`, `src/community-inventory.ts`, `src/list.ts` y `src/summary.ts` implementan las utilidades de diagnóstico y consulta.

## Datos locales y seguridad

- `.env` contiene credenciales y debe mantenerse fuera del control de versiones. No compartas el token del bot.
- `auth/` contiene la sesión de WhatsApp; `data/` contiene la cola SQLite y mensajes guardados localmente. Ambos directorios están excluidos por `.gitignore`.
- `pdfstesting/` contiene documentos locales de prueba y también está excluida por `.gitignore`.
- `data/chat-exports/` contiene transcripciones y adjuntos exportados localmente; el directorio `data/` está excluido por `.gitignore`.
- `data/history-captures/` contiene capturas temporales del historial crudo, potencialmente con datos personales; no las compartas ni las subas al repositorio y bórralas cuando ya no las necesites.
- `data/history-capture-auth/` contiene credenciales de una sesión WhatsApp aislada para captura de historial; protégelas como credenciales y no las compartas.
- La base SQLite se crea con permisos restrictivos para el usuario local. Los mensajes almacenados no están cifrados.
- `DRY_RUN=true` evita los reenvíos de la cola, pero no evita que el programa lea mensajes ni los guarde en SQLite. `npm run check` envía mensajes de prueba a Telegram incluso si `DRY_RUN=true`.
- `DRY_RUN` no afecta a `npm run test-send-whatsapp`; el comando no pide confirmación y su único texto/destino están fijados en el código.
- `DRY_RUN` no afecta a `npm run test-delete-whatsapp`; este comando no pide confirmación y solo acepta un ID de mensaje propio para el grupo de prueba.
- `DRY_RUN` no afecta a `npm run test-clear-starred`; el comando ejecuta un vaciado experimental sin confirmación y está limitado al grupo de prueba.

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