# Background music

`halo-menu-chant.mp3` is a 28-second continuous loop of the opening choir from the Halo: Combat Evolved menu on [Halome.nu](https://halome.nu/) ([original audio](https://halome.nu/loop.ogg)), retrieved October 17, 2026. The quiet tail after 29 seconds is removed. The final second (28–29) crossfades into the first second (0–1), then returns to the body (1–28), so the chant repeats without fading to silence. The clip is encoded as a 160 kbps MP3.

Halo music composed by Martin O'Donnell and Michael Salvatori. Halo © Microsoft Corporation. This project is not endorsed by or affiliated with Microsoft. This third-party recording is not relicensed as project code.

The Music panel has its own volume slider and mute button. Playback starts after the first click or key press at 15% volume by default. Volume and mute persist in local storage separately from sound effects; the M shortcut still controls only sound effects. Muting keeps the loop position and selected volume. A failed load offers a Retry button.

To reproduce the clip from the original download:

```sh
ffmpeg -i loop.ogg -filter_complex \
  '[0:a]asplit=3[body][tail][head];[body]atrim=start=1:end=28,asetpts=PTS-STARTPTS[bodyout];[tail]atrim=start=28:end=29,asetpts=PTS-STARTPTS[tailout];[head]atrim=start=0:end=1,asetpts=PTS-STARTPTS[headout];[tailout][headout]acrossfade=d=1:c1=qsin:c2=qsin[seam];[bodyout][seam]concat=n=2:v=0:a=1[out]' \
  -map '[out]' \
  -codec:a libmp3lame -b:a 160k -map_metadata -1 halo-menu-chant.mp3
```

Verification: the previous clip ended with 2.08 seconds below −40 dBFS. Repeating the new decoded audio three times (84 seconds) produces no silence intervals of at least 50 ms at that threshold, including both loop boundaries.
