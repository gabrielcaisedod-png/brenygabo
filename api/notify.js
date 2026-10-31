// Envía una notificación push a la otra persona.
// Variables en Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
import webpush from "web-push";

const U = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SR, Authorization: "Bearer " + SR };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "auth" });
    const ur = await fetch(U + "/auth/v1/user", { headers: { apikey: SR, Authorization: "Bearer " + token } });
    if (!ur.ok) return res.status(401).json({ error: "auth" });
    const email = String((await ur.json()).email || "").toLowerCase();
    const ar = await fetch(U + "/rest/v1/allowed?select=role&email=eq." + encodeURIComponent(email), { headers: H });
    const [me] = await ar.json();
    if (!me) return res.status(403).json({ error: "forbidden" });
    const to = me.role === "gabo" ? "brenda" : "gabo";
    const body = String((req.body && req.body.body) || "").slice(0, 240) || "Hay algo nuevo 💞";

    const sr = await fetch(U + "/rest/v1/push_subs?select=endpoint,sub&role=eq." + to, { headers: H });
    const subs = await sr.json();
    webpush.setVapidDetails("mailto:" + (process.env.VAPID_CONTACT || "gabrielcaisedod@gmail.com"), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: "Bren & Gabo", body, url: "/" }), { TTL: 86400 });
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await fetch(U + "/rest/v1/push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE", headers: H });
        }
      }
    }
    return res.status(200).json({ sent });
  } catch (e) {
    return res.status(500).json({ error: "server" });
  }
}
