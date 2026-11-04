"""One-shot official API redirect diagnosis; never bypass an access denial."""
import urllib.request,urllib.error,sys
opener=urllib.request.build_opener(type('NoRedirect',(urllib.request.HTTPRedirectHandler,),{'redirect_request':lambda *a:None})())
u=sys.argv[1] if len(sys.argv)>1 else 'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20151001&stockNo=0050'
try:
    with opener.open(u,timeout=20) as r:print(r.status,r.read(100))
except urllib.error.HTTPError as e:print(e.code,e.headers.get('Location'),e.headers.get('Retry-After'))
