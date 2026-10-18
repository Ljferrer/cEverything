# Sound overrides

The bundled set uses 17 World of Warcraft UI sounds, with Auction House open/close, money and coin effects, Level Up, and ReadyCheck. Each file is an unmodified original downloaded via [Wowhead](https://www.wowhead.com/sounds/user-interface) on October 17, 2026. World of Warcraft audio is by Blizzard Entertainment; these third-party assets are not relicensed as project code.

`src/features/sound.js` tries `/sfx/<cue>.ogg` first, then `/sfx/<cue>.mp3`. If a file loads and decodes, it plays for that cue. Any cue without a usable file keeps its synthesized sound.

Replace any cue file to customize the set. Accepted extensions: `.ogg`, `.mp3`.

| Cue | Plays on | Wowhead source | Original download |
|---|---|---|---|
| `select` | select an obelisk base | [AuctionWindowOpen](https://www.wowhead.com/sound=5274) | [AuctionWindowOpen.ogg](https://wow.zamimg.com/sound-ids/live/enus/186/567482/AuctionWindowOpen.ogg) |
| `slab` | select a slab | [Money Frame Open](https://www.wowhead.com/sound=677) | [iMoneyDialogOpen.ogg](https://wow.zamimg.com/sound-ids/live/enus/187/567483/iMoneyDialogOpen.ogg) |
| `miss` | click on nothing | [Deselect Target](https://www.wowhead.com/sound=870) | [iDeselectTarget.ogg](https://wow.zamimg.com/sound-ids/live/enus/224/567520/iDeselectTarget.ogg) |
| `spawn` | a new obelisk appears | [Level Up](https://www.wowhead.com/sound=888) | [LevelUp.ogg](https://wow.zamimg.com/sound-ids/live/enus/249/569593/LevelUp.ogg) |
| `waiting` | a session starts waiting for its user | [ReadyCheck](https://www.wowhead.com/sound=8960) | [levelup2.ogg](https://wow.zamimg.com/sound-ids/live/enus/182/567478/levelup2.ogg) |
| `tool-browser` | a browser tool starts | [Minimap Zoom](https://www.wowhead.com/sound=113) | [uMiniMapZoom.ogg](https://wow.zamimg.com/sound-ids/live/enus/171/567467/uMiniMapZoom.ogg) |
| `tool-filesystem` | a filesystem tool starts | [Spellbook Page Turn](https://www.wowhead.com/sound=831) | [iAbilitiesTurnPageA.ogg](https://wow.zamimg.com/sound-ids/live/enus/176/567472/iAbilitiesTurnPageA.ogg) |
| `tool-shell` | a shell tool starts | [Chat Scroll Button](https://www.wowhead.com/sound=1115) | [uChatScrollButton.ogg](https://wow.zamimg.com/sound-ids/live/enus/111/567407/uChatScrollButton.ogg) |
| `tool-other` | any other tool starts | [Select Target](https://www.wowhead.com/sound=867) | [iSelectTarget.ogg](https://wow.zamimg.com/sound-ids/live/enus/157/567453/iSelectTarget.ogg) |
| `tool-complete` | any tool completes | [Loot Coins](https://www.wowhead.com/sound=120) | [LootCoinSmall.ogg](https://wow.zamimg.com/sound-ids/live/enus/132/567428/LootCoinSmall.ogg) |
| `fork` | a fork is sent | [Spell Icon Pickup](https://www.wowhead.com/sound=837) | [uSpellIconPickup.ogg](https://wow.zamimg.com/sound-ids/live/enus/193/567489/uSpellIconPickup.ogg) |
| `pipe` | a pipe is sent | [Spell Icon Drop](https://www.wowhead.com/sound=689) | [uSpellIconDrop.ogg](https://wow.zamimg.com/sound-ids/live/enus/228/567524/uSpellIconDrop.ogg) |
| `say` | a typed message is sent | [Tell Message](https://www.wowhead.com/sound=3081) | [iTellMessage.ogg](https://wow.zamimg.com/sound-ids/live/enus/125/567421/iTellMessage.ogg) |
| `voice-start` | voice recording starts | [Map Ping](https://www.wowhead.com/sound=3175) | [MapPing.ogg](https://wow.zamimg.com/sound-ids/live/enus/120/567416/MapPing.ogg) |
| `voice-sent` | a voice recording is sent | [Backpack Close](https://www.wowhead.com/sound=686) | [iEquipmentContainerCloseA.ogg](https://wow.zamimg.com/sound-ids/live/enus/216/567512/iEquipmentContainerCloseA.ogg) |
| `voice-dropped` | a voice recording is dropped | [AuctionWindowClose](https://www.wowhead.com/sound=5275) | [AuctionWindowClose.ogg](https://wow.zamimg.com/sound-ids/live/enus/203/567499/AuctionWindowClose.ogg) |
| `error` | a relay or voice error | [Quest Failed](https://www.wowhead.com/sound=847) | [igQuestFailed.ogg](https://wow.zamimg.com/sound-ids/live/enus/163/567459/igQuestFailed.ogg) |

Prefer short files for frequent actions: every bundled tool cue is under 0.7 seconds. Level Up (4.36 seconds), ReadyCheck (5.02 seconds), and Auction House open/close (2.24/3.63 seconds) retain their original tails. Spawn, waiting, and tool sounds share a limiter with a burst of three starts, refilling at three per second; it does not truncate sounds already playing.

Files load when the page opens and decode after the first click or key press. The existing master gain, compressor, mute button, and M-key mute toggle apply to the bundled sounds.
