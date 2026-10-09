import sys
from PIL import Image
out=sys.argv[1]; files=sys.argv[2:]
ims=[Image.open(f).convert('RGB') for f in files]
h=900; ims=[i.resize((int(i.width*h/i.height),h)) for i in ims]
W=sum(i.width for i in ims)+10*(len(ims)-1)
s=Image.new('RGB',(W,h),(120,120,120));x=0
for i in ims: s.paste(i,(x,0)); x+=i.width+10
s.save(out,quality=85)
