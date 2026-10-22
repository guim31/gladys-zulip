# Zulip

Hable con Gladys desde [Zulip](https://zulip.com), la mensajería de equipo libre organizada en canales y
temas, como con el bot de Telegram de Gladys: haga una pregunta, lance una escena, reciba los mensajes de
Gladys en un mensaje directo. La integración también escribe en canales de Zulip desde sus escenas, y lanza
escenas cuando se escribe un mensaje o un comando como `!luces off` en un canal que vigila. Usa un bot
genérico de su organización Zulip: un servidor que usted aloja en la red local, o Zulip Cloud.

> **Desarrollada sin el hardware: se agradecen los comentarios.** La integración se ha probado contra un
> servidor Zulip real (12.3, en Docker), pero no dentro de un Gladys real ni con todas las aplicaciones de
> Zulip. Cuéntenos lo que funciona y lo que no en las
> [issues](https://github.com/guim31/gladys-zulip/issues) o en el
> [foro de Gladys](https://community.gladysassistant.com).

## Requisitos

- Gladys Assistant **5.1.0** o posterior.
- Una organización Zulip que Gladys pueda alcanzar: un servidor propio (versión 7 o posterior) o Zulip
  Cloud (el plan gratuito basta).
- Un **bot genérico** de esta organización (no un bot de webhook entrante ni saliente). No use su cuenta
  personal: el bot responde en su nombre.
- El correo o el identificador de cada persona autorizada a hablar con el bot.

## Configuración

1. En Zulip, **Configuración personal → Bots → Añadir un nuevo bot**: tipo **Bot genérico**, un nombre como
   `Gladys`, un correo como `gladys-bot`. Zulip le da un correo como `gladys-bot@example.zulipchat.com`.
2. En la ficha del bot, copie su **correo** y su **clave de API** (el icono de llave, o **Descargar
   zuliprc**).
3. En Gladys, **Integraciones → Zulip → Configuración**:
   - **Dirección de la organización**: la dirección de su organización como en el navegador, por ejemplo
     `https://example.zulipchat.com` o `http://192.168.1.20`.
   - **Correo del bot** y **Clave de API**: los del paso 2.
   - **Personas autorizadas**: las personas a las que escucha el bot, separadas por comas, por **correo tal
     como aparece en Zulip** o por **identificador** (`alice@example.org, 12`). **Vacío, el bot no responde
     a nadie**: ignora los mensajes de todos los que no están en esta lista. Muchas organizaciones ocultan
     los correos a los bots: use entonces el identificador, que aparece en el perfil de la persona (pulse
     su nombre y luego **Ver perfil**). Los registros de la integración también dan el identificador de
     una persona aún no autorizada cuando escribe al bot.
   - **Canales vigilados**: los canales cuyos mensajes lanzan escenas, por nombre (`garaje`, `#Salón`),
     separados por comas. El bot se suscribe solo a los canales públicos; suscríbalo antes a los privados.
     Un nombre que no existe se indica, nunca se crea.
   - **Prefijo de los comandos**: `!` por defecto (`/` abre los comandos de Zulip).
   - **Idioma del bot**: el idioma de lo que escribe el bot antes de que una persona esté vinculada.
4. Pulse **Probar la conexión**: el informe da el correo del bot, los canales vigilados y las personas
   autorizadas encontrados. El estado de conexión de la página también lo dice, y nombra un canal o una
   persona no encontrados.

### Vincular su cuenta Zulip para hablar con Gladys

Cada usuario de Gladys que quiera hablar con Gladys desde Zulip lo hace una vez:

1. En Gladys, **Integraciones → Zulip → Configuración**, bloque «Vincular mi cuenta»: pulse **Generar un
   código de vinculación**.
2. En Zulip, abra un **mensaje directo** con el bot (el **+** junto a «Mensajes directos», y luego su
   nombre) y envíele el código (8 caracteres). El bot lo confirma: su cuenta Zulip está vinculada a su
   usuario de Gladys. Puede desvincularla desde el mismo bloque.

## Qué hace el bot

- **En un mensaje directo** con una persona autorizada: transmite los mensajes a Gladys, con los permisos
  del usuario de Gladys vinculado, exactamente como el bot de Telegram: «¿Qué temperatura hace en el
  salón?», «Apaga las luces». Las respuestas de Gladys vuelven a este mensaje directo, con el Markdown
  mostrado por Zulip. Los mensajes que Gladys le envía (la acción de escena **Enviar un mensaje**, los
  mensajes del sistema) también llegan allí, incluso antes de cualquier conversación. Una imagen de cámara
  enviada por una escena llega como imagen.
- **En un canal vigilado**: cada mensaje de una persona autorizada, en cualquier tema, lanza el disparador
  **Mensaje Zulip recibido**, y un mensaje que empieza por el prefijo lanza además **Comando Zulip
  recibido**. Se quita una mención del bot al principio: `@**Gladys** !luces off` es el comando `luces`. El
  bot nunca responde allí por sí mismo: lo que ocurra depende de sus escenas.
- **En cualquier otro lugar** (un mensaje directo de grupo, un canal no vigilado): se calla. Gladys nunca
  responde donde otros pueden leer.
- **Lo que ignora**: a todos los que no son personas autorizadas, a todos los bots (también sus propios
  mensajes: una escena que escribe en un canal vigilado nunca se relanza a sí misma), las ediciones, y los
  mensajes de más de 5 minutos cuando los lee (un «!abrir garaje» de hace dos horas no se ejecuta ahora).
- **Tras un corte** (reinicio del servidor, de Gladys, la red): se reconecta solo. Zulip guarda para el bot
  los mensajes de un corte de menos de 10 minutos; tras uno más largo, o un reinicio, el bot vuelve a leer
  los mensajes de los últimos 5 minutos.

## Panel

El widget **Zulip** muestra si el bot está conectado, su correo, el número de canales vigilados, los 5
últimos mensajes recibidos en los canales vigilados (autor, tema, texto, fecha) y un botón **Probar la
conexión**. Los mensajes directos con Gladys nunca aparecen: todos los que ven el panel ven el widget.

## Escenas

### Disparadores

- **Mensaje Zulip recibido**: una persona autorizada ha escrito en un canal vigilado. Filtros (vacío =
  cualquiera): **Canal** (escrito como en la configuración, por ejemplo `garaje`), **Tema** (`puerta`) y
  **Remitente** (escrito como en las personas autorizadas: `alice@example.org` o `12`). Variables:
  Mensaje, Remitente, Nombre del remitente, Canal, Tema, Identificador del canal.
- **Comando Zulip recibido**: una persona autorizada ha escrito un comando en un canal vigilado: el
  prefijo, luego una palabra, luego argumentos opcionales, por ejemplo `!luces off cocina`. Filtro
  **Comando**: la palabra **sin el prefijo, en minúsculas** (`luces`); y Canal, Tema, Remitente. Variables:
  Comando (`luces`), Argumentos (`off cocina`), Mensaje, Remitente, Nombre del remitente, Canal, Tema,
  Identificador del canal. El mismo mensaje lanza también **Mensaje Zulip recibido**.
- **Conexión Zulip perdida**: el bot ya no alcanza el servidor, desde hace un minuto, o su clave es
  rechazada. Variable: Error. Se lanza una vez, hasta que vuelve la conexión.
- **Conexión Zulip restablecida**: el bot alcanza de nuevo el servidor tras una pérdida de conexión.
  Variable: Cuenta del bot (correo).

### Acciones

- **Enviar un mensaje Zulip**: escribe un mensaje en un canal (su nombre, `garaje` o `#garaje`) bajo un
  **Tema** (`Gladys` si está vacío), o a una persona en un mensaje directo (su correo, o `@` y su
  identificador: `@12`). El mensaje acepta las variables de escena y el Markdown de Zulip (`**negrita**`,
  `*cursiva*`, listas, enlaces, `@**all**`). El bot no necesita estar suscrito a un canal público.
  Resultados: Enviado (sí/no), Identificador del mensaje, Error. Un mensaje fallido no detiene la escena:
  compruebe **Enviado** con una condición si hace falta.

Para escribir a un usuario de Gladys, también sirve la acción **Enviar un mensaje** de Gladys: llega a su
cuenta Zulip vinculada.

### Ideas de escenas

- **Garaje por comando**: disparador **Comando Zulip recibido**, comando `garaje`, canal `garaje`; luego una
  condición sobre la variable Argumentos igual a `cerrar`, y la acción que cierra el garaje.
- **Lavadora terminada**: cuando baja la potencia del enchufe de la lavadora, **Enviar un mensaje Zulip** al
  canal `familia`, tema `Colada`: «La lavadora ha terminado».
- **Alerta si el bot se desconecta**: disparador **Conexión Zulip perdida**, y luego una notificación por
  otro canal (Gotify, ntfy, SMS) con la variable Error.

## Solución de problemas

- **«no hay servidor Zulip en esta dirección»**: use la dirección con la que abre Zulip en un navegador,
  sin `/login` ni lo que sigue a `#`. `https://<dirección>/api/v1/server_settings` debe responder
  `{"result":"success"…}`.
- **«correo o clave de API del bot rechazados»**: la clave se ha regenerado, el bot se ha desactivado, o el
  correo no es el del bot (`…-bot@…`). Cópielos de nuevo desde **Configuración personal → Bots**.
- **No se encuentra un canal vigilado**: el estado de la página y la prueba lo nombran. Compruebe su
  nombre; para un canal privado, suscriba antes el bot y luego guarde de nuevo la configuración.
- **No se encuentra una persona**: seguramente su organización oculta los correos a los bots: use el
  identificador. Los bots y las cuentas desactivadas nunca están autorizados.
- **El bot no me responde**: ¿está usted en **Personas autorizadas**? ¿Le escribe en un mensaje directo,
  solo ustedes dos (no un mensaje directo de grupo)? ¿Está su cuenta vinculada (el bot le da entonces las
  instrucciones)?
- **Un comando no lanza la escena**: el filtro Comando es la palabra sin el prefijo, en minúsculas:
  `luces`, no `!Luces`.
- Más detalles en los registros de la integración con `LOG_LEVEL=debug`.

## Limitaciones

- Una persona vinculada a Gladys puede hacer desde Zulip todo lo que puede su usuario de Gladys: mantenga
  corta la lista de personas autorizadas, y secreta la clave de API del bot.
- Un bot por Gladys. El bot lee los mensajes por la cola de eventos de Zulip (long polling): un comando
  surte efecto en un segundo aproximadamente. Los mensajes perdidos durante un corte de más de 5 minutos se
  omiten.
- Los archivos, imágenes y mensajes de voz enviados al bot llegan como su enlace Markdown; solo cuenta el
  texto. Las respuestas de Gladys van al mensaje directo, nunca a un canal.
- Zulip limita cada cuenta a 200 solicitudes por minuto por defecto: mantenga razonables los mensajes de
  sus escenas.
- Sin afiliación con Kandra Labs, Inc. Zulip es una marca de Kandra Labs, Inc.
