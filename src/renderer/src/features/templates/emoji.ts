// SPDX-License-Identifier: Apache-2.0
// The template icon picker's Emojis tab: a curated list of common emoji with
// English names, loaded lazily. No emoji dataset dependency. A template stores the
// emoji with its code points as upper-case hex joined by "-".

export interface EmojiEntry {
  value: string
  name: string
  hexcode: string
}

const LIST = `
😀 grinning face|😃 smiling face with big eyes|😄 smiling face with smiling eyes|😁 beaming face|😆 grinning squinting face|😅 grinning face with sweat|😂 face with tears of joy|🙂 slightly smiling face|😉 winking face|😊 smiling face|😇 smiling face with halo|🥰 smiling face with hearts|😍 heart eyes|🤩 star struck|😘 face blowing a kiss|😋 face savoring food|😎 smiling face with sunglasses|🤓 nerd face|🧐 face with monocle|🤔 thinking face|🤨 face with raised eyebrow|😐 neutral face|😶 face without mouth|🙄 face with rolling eyes|😏 smirking face|😌 relieved face|😴 sleeping face|🥱 yawning face|😮 face with open mouth|😲 astonished face|🤯 exploding head|😬 grimacing face|😳 flushed face|🥳 partying face|🤠 cowboy hat face|🤗 hugging face|🤫 shushing face|🤭 face with hand over mouth|😤 face with steam|😢 crying face|😭 loudly crying face|😱 face screaming in fear|😡 pouting face|🤖 robot|👻 ghost|👽 alien|💩 pile of poo|
👋 waving hand|🤚 raised back of hand|✋ raised hand|🖖 vulcan salute|👌 ok hand|🤌 pinched fingers|✌️ victory hand|🤞 crossed fingers|🤟 love you gesture|👍 thumbs up|👎 thumbs down|👏 clapping hands|🙌 raising hands|🤝 handshake|🙏 folded hands|💪 flexed biceps|✍️ writing hand|👀 eyes|🧠 brain|🫶 heart hands|
👤 bust in silhouette|👥 busts in silhouette|🧑‍💻 technologist|🧑‍💼 office worker|🧑‍🏫 teacher|🧑‍🔬 scientist|🧑‍🎨 artist|🧑‍⚕️ health worker|🧑‍🚀 astronaut|🕵️ detective|💁 person tipping hand|🙋 person raising hand|🤷 person shrugging|🧘 person in lotus position|🏃 person running|
❤️ red heart|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💯 hundred points|💥 collision|💫 dizzy|💬 speech balloon|💭 thought balloon|🗨️ left speech bubble|💡 light bulb|🔥 fire|✨ sparkles|⭐ star|🌟 glowing star|⚡ high voltage|☀️ sun|🌙 crescent moon|🌈 rainbow|☁️ cloud|❄️ snowflake|🌊 water wave|🌱 seedling|🌳 deciduous tree|🌵 cactus|🌸 cherry blossom|🌻 sunflower|🍀 four leaf clover|🍁 maple leaf|
🐶 dog face|🐱 cat face|🦊 fox|🐻 bear|🐼 panda|🦁 lion|🐯 tiger face|🐸 frog|🐵 monkey face|🦉 owl|🐝 honeybee|🦋 butterfly|🐢 turtle|🐙 octopus|🐳 spouting whale|🦄 unicorn|
🍎 red apple|🍋 lemon|🍉 watermelon|🍓 strawberry|🥑 avocado|🍕 pizza|🍔 hamburger|🌮 taco|🍣 sushi|🍪 cookie|🎂 birthday cake|🍩 doughnut|☕ hot beverage|🍵 teacup|🍺 beer mug|🍷 wine glass|🥂 clinking glasses|
⚽ soccer ball|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏓 ping pong|🎯 direct hit|🎲 game die|🧩 puzzle piece|♟️ chess pawn|🎮 video game|🏆 trophy|🥇 first place medal|🏅 sports medal|🎖️ military medal|
🎉 party popper|🎊 confetti ball|🎈 balloon|🎁 wrapped gift|🎀 ribbon|🎨 artist palette|🎭 performing arts|🎬 clapper board|🎤 microphone|🎧 headphone|🎵 musical note|🎸 guitar|🎹 musical keyboard|📸 camera with flash|
🚀 rocket|✈️ airplane|🚗 automobile|🚲 bicycle|🚢 ship|🗺️ world map|🧭 compass|🏔️ snow capped mountain|🏝️ desert island|🏠 house|🏢 office building|🏫 school|🏥 hospital|🏛️ classical building|🌍 globe showing europe africa|🌎 globe showing americas|🌏 globe showing asia australia|
⌚ watch|📱 mobile phone|💻 laptop|🖥️ desktop computer|⌨️ keyboard|🖱️ computer mouse|💾 floppy disk|📀 dvd|📞 telephone receiver|☎️ telephone|📟 pager|📠 fax machine|📺 television|📻 radio|🎙️ studio microphone|⏰ alarm clock|⏳ hourglass not done|⌛ hourglass done|🔋 battery|🔌 electric plug|🔦 flashlight|🕯️ candle|
💰 money bag|💵 dollar banknote|💳 credit card|💎 gem stone|⚖️ balance scale|🔧 wrench|🔨 hammer|🛠️ hammer and wrench|⚙️ gear|🧰 toolbox|🧲 magnet|🧪 test tube|🔬 microscope|🔭 telescope|🩺 stethoscope|💊 pill|🧬 dna|
✉️ envelope|📧 e-mail|📨 incoming envelope|📩 envelope with arrow|📤 outbox tray|📥 inbox tray|📦 package|📫 closed mailbox with raised flag|📝 memo|📄 page facing up|📃 page with curl|📑 bookmark tabs|📊 bar chart|📈 chart increasing|📉 chart decreasing|📋 clipboard|📌 pushpin|📍 round pushpin|📎 paperclip|✂️ scissors|📁 file folder|📂 open file folder|🗂️ card index dividers|🗃️ card file box|🗄️ file cabinet|🗓️ spiral calendar|📅 calendar|📆 tear off calendar|📇 card index|📒 ledger|📓 notebook|📔 notebook with decorative cover|📕 closed book|📗 green book|📘 blue book|📙 orange book|📚 books|📖 open book|🔖 bookmark|🏷️ label|✏️ pencil|✒️ black nib|🖊️ pen|🖋️ fountain pen|🖍️ crayon|🖌️ paintbrush|🔍 magnifying glass tilted left|🔎 magnifying glass tilted right|🔒 locked|🔓 unlocked|🔑 key|🗝️ old key|
✅ check mark button|☑️ check box with check|✔️ check mark|❌ cross mark|❓ red question mark|❗ red exclamation mark|⚠️ warning|🚧 construction|🚦 vertical traffic light|🛑 stop sign|🔔 bell|📣 megaphone|📢 loudspeaker|🔁 repeat button|🔄 counterclockwise arrows button|➕ plus|➖ minus|➗ divide|♾️ infinity|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟩 green square|🟦 blue square|🏁 chequered flag|🚩 triangular flag|🏳️ white flag
`

let cache: EmojiEntry[] | null = null

function hexcode(value: string): string {
  return Array.from(value)
    .map((c) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0'))
    .join('-')
}

/** The curated list, parsed once. */
export function emojiList(): EmojiEntry[] {
  if (cache) return cache
  cache = LIST.split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const space = item.indexOf(' ')
      const value = item.slice(0, space)
      return { value, name: item.slice(space + 1).trim(), hexcode: hexcode(value) }
    })
  return cache
}
