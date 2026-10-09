/** Keep hydrated links and client-side requests inside this project's signed preview route. */
export function previewBrowserBridge(prefix: string, token: string): string {
  return `<script>(function(){
  const prefix=${JSON.stringify(prefix)},token=${JSON.stringify(token)};
  function route(value){
    if(typeof value!=="string" || !value || value.startsWith("#"))return value;
    const url=new URL(value,location.href);
    if(url.origin!==location.origin || url.pathname.startsWith("/v1/projects/") || url.pathname.startsWith("/api/") && !url.pathname.startsWith(prefix+"/"))return value;
    if(!url.pathname.startsWith(prefix+"/"))url.pathname=prefix+url.pathname;
    url.searchParams.set("token",token);return url.href;
  }
  document.addEventListener("click",function(event){
    const link=event.target instanceof Element ? event.target.closest("a[href]") : null;
    if(!link || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute("download"))return;
    const href=link.getAttribute("href"),routed=route(href);
    if(!href || href.startsWith("#") || routed===href)return;
    const url=new URL(routed,location.href);if(url.origin!==location.origin || !url.pathname.startsWith(prefix+"/"))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(link.target==="_blank")window.open(routed,"_blank","noopener");else location.assign(routed);
  },true);
  const fetchOriginal=window.fetch.bind(window);
  window.fetch=function(input,init){return fetchOriginal(input instanceof Request ? new Request(route(input.url),input) : route(String(input)),init);};
  for(const method of ["pushState","replaceState"]){const original=history[method].bind(history);history[method]=function(state,title,url){return original(state,title,url==null?url:route(String(url)));};}
  })();</script>`;
}
