import re,sys
for name,css,js in (('index','styles.css','app.js'),('admin','admin.css','admin.js')):
    s=open(name+'.html',encoding='utf-8').read()
    m=re.search(r'<style>\n(.*?)</style>\n',s,re.S)
    open(css,'w',encoding='utf-8').write(m.group(1))
    s=s[:m.start()]+'<link rel="stylesheet" href="%s?v=1">\n'%css+s[m.end():]
    m=re.search(r'<script type="module">\n(.*?)</script>',s,re.S)
    open(js,'w',encoding='utf-8').write(m.group(1))
    s=s[:m.start()]+'<script type="module" src="%s?v=1"></script>'%js+s[m.end():]
    open(name+'.html','w',encoding='utf-8').write(s)
