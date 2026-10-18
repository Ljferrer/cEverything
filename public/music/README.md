# Background music

`halo-menu-chant.mp3` is the opening 32 seconds of the Halo: Combat Evolved menu loop from [Halome.nu](https://halome.nu/) ([original audio](https://halome.nu/loop.ogg)), retrieved October 17, 2026. This retains the opening choir and its quiet tail before the rest of the theme. A 20 ms fade-in and a two-second fade-out at 30 seconds smooth the loop boundary; the clip is encoded as a 160 kbps MP3.

Halo music composed by Martin O'Donnell and Michael Salvatori. Halo © Microsoft Corporation. This project is not endorsed by or affiliated with Microsoft. This third-party recording is not relicensed as project code.

The Music panel has its own volume slider and mute button. Playback starts after the first click or key press at 15% volume by default. Volume and mute persist in local storage separately from sound effects; the M shortcut still controls only sound effects. Muting keeps the loop position and selected volume. A failed load offers a Retry button.

To reproduce the clip from the original download:

```sh
ffmpeg -i loop.ogg -t 32 \
  -af 'afade=t=in:d=0.02,afade=t=out:st=30:d=2' \
  -codec:a libmp3lame -b:a 160k -map_metadata -1 halo-menu-chant.mp3
```
