/** Source assets use only a publishable key; no database or service credentials. */
export function createWebsiteDataFiles(apiUrl: string, publishableKey: string, projectId: string, commerce: boolean): Record<string, string> {
  const files: Record<string, string> = {
    "lib/project-client.ts": `"use client";
import { createProjectClient } from "../npati-client";
export const projectClient = createProjectClient(${JSON.stringify({ apiUrl, publishableKey, projectId })});
`,
    "components/ProjectAccount.tsx": `"use client";
import { useEffect, useState, type FormEvent } from "react";
import { projectClient } from "../lib/project-client";
export function ProjectAccount() {
  const [email, setEmail] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { projectClient.auth.getUser().then(user => setEmail(user?.email ?? null)).catch(() => {}); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const credentials = { email: String(form.get("email")), password: String(form.get("password")) };
    try {
      if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "register") await projectClient.auth.signUp(credentials);
      else await projectClient.auth.signIn(credentials);
      const user = await projectClient.auth.getUser(); setEmail(user?.email ?? null);
      setMessage(user ? "Ви увійшли." : "Перевірте електронну пошту для підтвердження реєстрації.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Не вдалося увійти."); }
    finally { setBusy(false); }
  }
  return <section className="card" style={{maxWidth:520,margin:"40px auto",padding:24}}><h1>Особистий кабінет</h1>
    {email ? <><p>{email}</p><button onClick={async () => { try { await projectClient.auth.signOut(); setEmail(null); } catch (error) { setMessage(String(error)); } }}>Вийти</button></>
    : <form onSubmit={submit}><label>Email<input name="email" type="email" required autoComplete="email" /></label><label>Пароль<input name="password" type="password" required minLength={8} autoComplete="current-password" /></label><button name="action" value="login" disabled={busy}>Увійти</button><button name="action" value="register" disabled={busy}>Зареєструватися</button></form>}
    <p role="status">{message}</p><a href="/">На головну</a>${commerce ? '<a href="/shop">Магазин</a>' : ""}</section>;
}
`,
    "app/auth/page.tsx": `import { ProjectAccount } from "../../components/ProjectAccount";\nexport default function AccountPage() { return <ProjectAccount />; }\n`,
    "components/ProjectForm.tsx": `"use client";
import { useState, type FormEvent } from "react";
import { projectClient } from "../lib/project-client";
type Field = { name?: string; label?: string; type?: string; required?: boolean };
export function ProjectForm({ collection="form_submissions", fields=[{name:"name",label:"Ім’я",required:true},{name:"email",label:"Email",type:"email",required:true},{name:"message",label:"Повідомлення",type:"textarea",required:true}], title="Зв’язатися з нами" }: {collection?:string;fields?:Field[];title?:string}) {
  const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=event.currentTarget; const values=Object.fromEntries(new FormData(form)); setBusy(true);setMessage("");
    try { const response = await projectClient.fetchRaw("/forms/"+encodeURIComponent(collection)+"/submit", {method:"POST",body:JSON.stringify(collection === "form_submissions" ? {form_name:title,payload:values} : values)}); if(!response.ok){const result=await response.json();throw new Error(result.error?.message || "Не вдалося зберегти форму.");} setMessage("Дані збережено."); form.reset(); }
    catch(error) {setMessage(error instanceof Error ? error.message : "Помилка збереження.");} finally {setBusy(false);}
  }
  return <form className="card" onSubmit={submit}><h3>{title}</h3>{fields.map((field,index) => <label key={index} style={{display:"block",marginBottom:12}}>{field.label || field.name}{field.type === "textarea" ? <textarea name={field.name || "field_"+index} required={field.required} maxLength={4000} /> : <input name={field.name || "field_"+index} type={field.type === "email" ? "email" : field.type === "number" ? "number" : "text"} required={field.required} maxLength={1000} />}</label>)}<button type="submit" disabled={busy}>Надіслати</button><p role="status">{message}</p></form>;
}
`,
  };
  if (commerce) {
    files["components/ProjectStore.tsx"] = `"use client";
import { useEffect,useState } from "react";
import { projectClient } from "../lib/project-client";
type Product={id:string;title:string;price:string;description?:string}; type Variant={id:string;product_id:string;price:string}; type CartItem={id:string;variant_id:string;quantity:number};type Cart={id:string;owner_id:string;status:string;currency:string};
export function ProjectStore() {
  const [products,setProducts]=useState<Product[]>([]);const [variants,setVariants]=useState<Variant[]>([]);const [items,setItems]=useState<CartItem[]>([]);const [cartId,setCartId]=useState("");const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);
  async function loadCart() { const user=await projectClient.auth.getUser();if(!user)return; const carts=await projectClient.from<{id:string}>("carts").list({filter:{status:"active"}}); const id=carts.data[0]?.id;if(id){setCartId(id);setItems((await projectClient.from<CartItem>("cart_items").list({filter:{cart_id:id}})).data);} }
  useEffect(()=>{Promise.all([projectClient.from<Product>("products").list({filter:{is_active:true}}),projectClient.from<Variant>("product_variants").list()]).then(([p,v])=>{setProducts(p.data);setVariants(v.data);}).catch(error=>setMessage(String(error)));loadCart().catch(()=>{});},[]);
  async function add(product:Product){setBusy(true);try{const user=await projectClient.auth.getUser();if(!user)throw new Error("Увійдіть або зареєструйтеся перед додаванням у кошик.");const variant=variants.find(v=>v.product_id===product.id);if(!variant)throw new Error("Товар тимчасово недоступний.");let id=cartId;if(!id){const cart=await projectClient.from<Cart>("carts").create({owner_id:user.id,status:"active",currency:"UAH"});id=cart.id;setCartId(id);}const existing=items.find(item=>item.variant_id===variant.id);if(existing)await projectClient.from("cart_items").update(existing.id,{quantity:Number(existing.quantity)+1});else await projectClient.from("cart_items").create({cart_id:id,variant_id:variant.id,quantity:1,owner_id:user.id});setItems((await projectClient.from<CartItem>("cart_items").list({filter:{cart_id:id}})).data);setMessage("Товар додано до кошика.");}catch(error){setMessage(error instanceof Error ? error.message : String(error));}finally{setBusy(false);}}
  async function checkout(){setBusy(true);try{const response=await projectClient.fetchRaw("/commerce/checkout",{method:"POST",body:JSON.stringify({cartId})});const result=await response.json();if(!response.ok)throw new Error(result.error?.message || "Помилка замовлення.");setItems([]);setCartId("");setMessage("Замовлення "+result.order.order_number+" створено. Сума: "+result.order.total_amount+" UAH");}catch(error){setMessage(error instanceof Error ? error.message : String(error));}finally{setBusy(false);}}
  return <main className="container" style={{padding:32}}><nav><a href="/">Головна</a> · <a href="/auth">Вхід / Реєстрація</a></nav><h1>Інтернет-магазин</h1><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:24}}>{products.map(product=><article className="card" key={product.id}><h2>{product.title}</h2><p>{product.description}</p><strong>{product.price} UAH</strong><p><button disabled={busy} onClick={()=>add(product)}>До кошика</button></p></article>)}</div><h2>Кошик: {items.reduce((sum,item)=>sum+Number(item.quantity),0)} товарів</h2><button disabled={busy || !items.length} onClick={checkout}>Оформити замовлення</button><p role="status">{message}</p></main>;
}
`;
    files["app/shop/page.tsx"] = `import { ProjectStore } from "../../components/ProjectStore";\nexport default function ShopPage() { return <ProjectStore />; }\n`;
    files["app/page.tsx"] = files["app/shop/page.tsx"].replaceAll("../../", "../");
  }
  return files;
}
