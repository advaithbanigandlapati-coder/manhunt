"""Regenerate the announcer clips in app/public/voice.

Voice: Kokoro-82M "bm_lewis" (deep British male), Apache-2.0.
Setup:  pip install kokoro-onnx soundfile
        npm pack expo-kokoro && tar xzf expo-kokoro-*.tgz   (ships the model + voices)
Run:    python tools/make_voice.py path/to/package/build
Needs ffmpeg on PATH.
"""
import sys, subprocess, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

build = sys.argv[1]
np.savez('/tmp/voices.npz', bm_lewis=np.fromfile(f'{build}/voices/bm_lewis.bin', dtype=np.float32).reshape(510, 1, 256))
k = Kokoro(f'{build}/kokoro-quantized.onnx', '/tmp/voices.npz')
LINES = {
    'start': 'The hunt has begun. Hunters are frozen. Run.', 'released': 'Hunters released.',
    'ping_incoming': 'Location ping incoming.', 'ping': 'Locations revealed.',
    'endgame': 'Endgame. One team remains. Reveals are now random.', 'tagged': 'You have been tagged.',
    'caught': 'Player down.', 'dq': 'Player disqualified.', 'camping': 'Camping detected. Your position is exposed.',
    'outside': 'Warning. You have left the play area.', 'inside': 'Back inside the area.', 'target': 'Target in range.',
    'freeze_broken': 'Freeze broken. The hunters lose.', 'hunters_win': 'Hunters win.', 'hiders_win': 'Hiders win.',
    'match_over': 'Match over.', 'vote_started': 'A vote to end the match has started.',
    'vote_passed': 'Vote passed. Ending the match.', 'alliance': 'Alliance formed.', 'dispute': 'Hit disputed. Cast your vote.',
    'min30': 'Thirty minutes remaining.', 'min10': 'Ten minutes remaining.', 'min5': 'Five minutes remaining.',
    'min1': 'One minute remaining.', 'ready': 'Systems ready.',
}
# a touch deeper, presence boost, light compression, small "control room" echo
CHAIN = ("asetrate=24000*0.94,aresample=24000,atempo=1.0638,highpass=f=70,equalizer=f=140:t=q:w=1:g=3,"
         "equalizer=f=2800:t=q:w=1.4:g=2.5,acompressor=threshold=-20dB:ratio=3:attack=4:release=90:makeup=2,"
         "aecho=0.85:0.45:38|71:0.22|0.12,apad=pad_dur=0.25,loudnorm=I=-15:TP=-1.5:LRA=7")
for key, text in LINES.items():
    a, sr = k.create(text, voice='bm_lewis', speed=0.9, lang='en-gb')
    sf.write(f'/tmp/{key}.wav', a, sr)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'/tmp/{key}.wav', '-af', CHAIN, '-ac', '1', '-ar', '24000',
                    '-c:a', 'libmp3lame', '-b:a', '56k', f'app/public/voice/{key}.mp3'], check=True)
    print('wrote', key)
