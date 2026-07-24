import json
d = json.load(open('test-rq.json'))
c = d.get('captions')
print('captions:', 'found' if c else 'MISSING')
tr = c.get('playerCaptionsTracklistRenderer') if c else None
print('tracklistRenderer:', 'found' if tr else 'MISSING')
tracks = tr.get('captionTracks', []) if tr else []
print(f'tracks: {len(tracks)}')
for t in tracks[:5]:
    print(f'  {t["languageCode"]}')