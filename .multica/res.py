import sys,re
# usage: res.py file sep1 sep2 ... ; each arg is the separator between ours+theirs for conflict n ('' = concat, 'O' = ours only, 'T' = theirs only)
p=sys.argv[1]; modes=sys.argv[2:]
s=open(p).read()
pat=re.compile(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> origin/main\n',re.S)
i=[0]
def f(m):
    md=modes[i[0]]; i[0]+=1
    if md=='O': return m.group(1)
    if md=='T': return m.group(2)
    return m.group(1)+md.encode().decode('unicode_escape')+m.group(2)
s=pat.sub(f,s); open(p,'w').write(s)
