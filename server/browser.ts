// Integrated browser support:
//  - webFetch(): used by the agent's fetch_url tool (HTML → readable text + interactive elements)
//  - proxy(): serves http://localhost:<port>/<path> under /preview/<port>/<path> so the
//    IDE's browser panel can show local dev servers even when the IDE itself is remote.
//    HTML responses get a small inspector script injected (Design Mode / element picking).
import type { Context } from 'hono'

const TIMEOUT = 20_000

function htmlToText(html: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || ''
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const interactive: string[] = []
  for (const m of body.matchAll(/<(a|button|select|textarea|form)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)>()/gi)) {
    if (m[4]) { m[1] = m[4]; m[2] = m[5]; m[3] = '' }
    if (interactive.length > 60) break
    const tag = m[1].toLowerCase()
    const attrs = m[2]
    const attr = (n: string) => new RegExp(`${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1]
    const text = m[3]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    const bits = [attr('id') && `#${attr('id')}`, attr('name') && `name=${attr('name')}`, attr('type') && `type=${attr('type')}`, attr('href') && `href=${attr('href')}`, attr('placeholder') && `placeholder="${attr('placeholder')}"`].filter(Boolean)
    interactive.push(`<${tag}${bits.length ? ' ' + bits.join(' ') : ''}>${text ? ' ' + text : ''}`)
  }
  const text = body
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<h(\d)[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
  return `Title: ${title}\n\n${text.slice(0, 12000)}${interactive.length ? `\n\nInteractive elements:\n${interactive.join('\n')}` : ''}`
}

export async function webFetch(url: string, o: { method?: string; body?: string; raw?: boolean; signal?: AbortSignal } = {}) {
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  o.signal?.addEventListener('abort', () => ctrl.abort())
  try {
    const r = await fetch(url, {
      method: o.method || (o.body ? 'POST' : 'GET'),
      body: o.body,
      headers: o.body && /^\s*[{[]/.test(o.body) ? { 'content-type': 'application/json' } : undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    })
    const ct = r.headers.get('content-type') || ''
    let body = await r.text()
    if (!o.raw && ct.includes('html')) body = htmlToText(body)
    const head = `HTTP ${r.status} ${r.statusText}\ncontent-type: ${ct}\nurl: ${r.url}\n\n`
    return { status: r.status, url: r.url, text: head + body }
  } catch (e: any) {
    return { status: 0, url, text: `Request failed: ${e?.cause?.code || e?.message || e}` }
  } finally { clearTimeout(t) }
}

// ---------------------------------------------------------------- proxy
const INSPECTOR = `<script data-cursorweb-inspector>(function(){
  var on=false, box, lab, cur;
  function sel(el){ if(!el||el.nodeType!==1) return ''; if(el.id) return '#'+el.id; var s=el.tagName.toLowerCase();
    if(el.className&&typeof el.className==='string'){ var c=el.className.trim().split(/\\s+/).slice(0,2).join('.'); if(c) s+='.'+c }
    var p=el.parentElement; if(p&&p!==document.body){ var sib=[].filter.call(p.children,function(x){return x.tagName===el.tagName}); if(sib.length>1) s+=':nth-of-type('+(sib.indexOf(el)+1)+')'; return sel(p)+' > '+s } return s }
  function ensure(){ if(box) return; box=document.createElement('div'); box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4daafc;background:rgba(77,170,252,.12);border-radius:3px;transition:all .05s';
    lab=document.createElement('div'); lab.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#4daafc;color:#000;font:11px/1.4 monospace;padding:1px 5px;border-radius:3px';
    document.documentElement.appendChild(box); document.documentElement.appendChild(lab) }
  function show(el){ ensure(); var r=el.getBoundingClientRect(); box.style.display=lab.style.display='block';
    box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px';
    lab.textContent=el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+' '+Math.round(r.width)+'×'+Math.round(r.height); lab.style.left=r.left+'px'; lab.style.top=Math.max(0,r.top-18)+'px' }
  function hide(){ if(box){box.style.display=lab.style.display='none'} }
  document.addEventListener('mousemove',function(e){ if(!on) return; cur=e.target; show(cur) },true);
  document.addEventListener('click',function(e){ if(!on) return; e.preventDefault(); e.stopPropagation(); var el=e.target, cs=getComputedStyle(el), r=el.getBoundingClientRect();
    parent.postMessage({ cursorweb:'pick', selector: sel(el), tag: el.tagName.toLowerCase(), text:(el.innerText||'').trim().slice(0,200), html: el.outerHTML.slice(0,600),
      rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
      styles:{ color:cs.color, background:cs.backgroundColor, font:cs.fontSize+' '+cs.fontWeight+' '+cs.fontFamily.split(',')[0], margin:cs.margin, padding:cs.padding, display:cs.display } }, '*') },true);
  window.addEventListener('message',function(e){ var d=e.data||{}; if(d.cursorweb==='inspect'){ on=!!d.on; document.documentElement.style.cursor=on?'crosshair':''; if(!on) hide() } });
  function nav(){ parent.postMessage({ cursorweb:'nav', href: location.href, title: document.title }, '*') }
  window.addEventListener('load', nav); nav();
  var oe=console.error; console.error=function(){ try{ parent.postMessage({cursorweb:'console', level:'error', text:[].map.call(arguments,String).join(' ')},'*') }catch(_){} return oe.apply(console,arguments) };
  window.addEventListener('error',function(e){ parent.postMessage({cursorweb:'console', level:'error', text:String(e.message)},'*') });
})();</script>`

export async function proxy(c: Context) {
  const port = Number(c.req.param('port'))
  if (!port || port < 1 || port > 65535 || port === Number(process.env.PORT || 3000)) return c.text('Invalid port', 400)
  const url = new URL(c.req.url)
  const prefix = `/preview/${port}`
  const rest = url.pathname.slice(prefix.length) || '/'
  const target = `http://127.0.0.1:${port}${rest}${url.search}`
  const headers = new Headers(c.req.raw.headers)
  headers.delete('host'); headers.delete('accept-encoding'); headers.delete('cookie')
  headers.set('host', `localhost:${port}`)
  let r: Response
  try {
    r = await fetch(target, { method: c.req.method, headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.arrayBuffer(), redirect: 'manual' })
  } catch (e: any) {
    return c.html(`<html><body style="font:14px system-ui;background:#121314;color:#bbb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:40px">⚠</div><p>Cannot connect to <b>localhost:${port}</b></p><p style="color:#777">${e?.cause?.code || e?.message}</p><p style="color:#777">Start a dev server (e.g. from the terminal or ask an agent), then reload.</p></div></body></html>`, 502)
  }
  const out = new Headers(r.headers)
  out.delete('content-encoding'); out.delete('content-length'); out.delete('x-frame-options'); out.delete('content-security-policy')
  const loc = out.get('location')
  if (loc) {
    try { const l = new URL(loc, `http://localhost:${port}${rest}`); if (/^(localhost|127\.0\.0\.1)$/.test(l.hostname)) out.set('location', `/preview/${l.port || 80}${l.pathname}${l.search}`) } catch { /* keep */ }
  }
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('text/html')) {
    let html = await r.text()
    // rewrite root-relative URLs so assets resolve through the proxy
    html = html.replace(/(\s(?:src|href|action)=["'])\/(?!\/)/gi, `$1${prefix}/`)
    html = html.replace(/(from\s+["']|import\(\s*["'])\/(?!\/)/g, `$1${prefix}/`)
    const inject = `<base href="${prefix}${rest.endsWith('/') ? rest : rest.replace(/[^/]*$/, '')}">` + INSPECTOR
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html
    return new Response(html, { status: r.status, headers: out })
  }
  if (ct.includes('javascript') || ct.includes('text/css')) {
    let txt = await r.text()
    txt = txt.replace(/(from\s*["']|import\s*["']|import\(\s*["']|url\(\s*["']?)\/(?!\/)/g, `$1${prefix}/`)
    return new Response(txt, { status: r.status, headers: out })
  }
  return new Response(r.body, { status: r.status, headers: out })
}
