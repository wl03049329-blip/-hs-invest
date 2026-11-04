"""One-shot official API redirect diagnosis; never bypass an access denial."""
import urllib.request,urllib.error
opener=urllib.request.build_opener(type('NoRedirect',(urllib.request.HTTPRedirectHandler,),{'redirect_request':lambda *a:None})())
u='https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20151001&stockNo=0050'
try:
    with opener.open(u,timeout=20) as r:print(r.status)
except urllib.error.HTTPError as e:print(e.code,e.headers.get('Location'),e.headers.get('Retry-After'))
