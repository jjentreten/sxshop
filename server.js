require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname)));

const BC_BASE = "https://api.blackcatpay.com.br/api";
const BC_KEY = (process.env.BLACKCAT_API_KEY || "").trim();
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = (process.env.UTMIFY_API_TOKEN || "").trim();
const SITE_URL = (process.env.SITE_URL || "http://localhost:" + (process.env.PORT || 3000)).replace(/\/$/, "");
const PENDING_FILE = path.join(__dirname, "data", "pending-utmify-orders.json");
const POLL_INTERVAL_MS = 30 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toUtcDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function ensureDataDir() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPending() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) || []; } catch { return []; }
}

function writePending(list) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list), "utf8");
}

// ── BlackCat API ──────────────────────────────────────────────────────────────

async function bcRequest(method, endpoint, body) {
  const url = `${BC_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": BC_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || "BlackCat API error");
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json.data !== undefined ? json.data : json;
}

// ── UTMify ────────────────────────────────────────────────────────────────────

function buildUtmifyPayload({ orderId, status, createdAt, approvedDate, customer, products, tracking, totalPriceInCents }) {
  const gatewayFee = Math.round(totalPriceInCents * 0.01) || 0;
  const userCommission = Math.max(1, totalPriceInCents - gatewayFee);
  return {
    orderId: String(orderId),
    platform: "DiscrettaSexShop",
    paymentMethod: "pix",
    status,
    createdAt,
    approvedDate: approvedDate || null,
    refundedAt: null,
    customer: {
      name: customer.name,
      email: customer.email || "cliente@discrettasexshop.com.br",
      phone: customer.phone || null,
      document: customer.document || null,
      country: "BR",
      ip: customer.ip || "0.0.0.0",
    },
    products: products.map((p) => ({
      id: String(p.id || p.name),
      name: p.name,
      planId: null,
      planName: null,
      quantity: p.quantity || 1,
      priceInCents: p.priceInCents,
    })),
    trackingParameters: {
      src: tracking?.src ?? null,
      sck: tracking?.sck ?? null,
      utm_source: tracking?.utm_source ?? null,
      utm_campaign: tracking?.utm_campaign ?? null,
      utm_medium: tracking?.utm_medium ?? null,
      utm_content: tracking?.utm_content ?? null,
      utm_term: tracking?.utm_term ?? null,
    },
    commission: { totalPriceInCents, gatewayFeeInCents: gatewayFee, userCommissionInCents: userCommission },
  };
}

async function sendToUtmify(payload) {
  if (!UTMIFY_TOKEN) return;
  try {
    const res = await fetch(UTMIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": UTMIFY_TOKEN },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) console.error(`UTMify erro ${res.status}:`, text);
    else console.log(`UTMify: pedido ${payload.orderId} → ${payload.status}`);
  } catch (err) {
    console.error("UTMify erro:", err.message);
  }
}

// ── POST /api/criar-pix ───────────────────────────────────────────────────────
// Frontend envia: { customer, items, metadata, coupon, tracking }

app.post("/api/criar-pix", async (req, res) => {
  const { customer, items = [], tracking } = req.body;

  if (!customer?.name) {
    return res.status(400).json({ error: "Nome do cliente é obrigatório." });
  }
  if (!items.length) {
    return res.status(400).json({ error: "Carrinho vazio." });
  }

  // unitPrice já vem em centavos do frontend (via centavos())
  const amountCents = items.reduce((sum, i) => sum + Math.round((i.unitPrice || 0) * (i.quantity || 1)), 0);
  if (amountCents <= 0) {
    return res.status(400).json({ error: "Valor inválido." });
  }

  const orderId = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = toUtcDateTime(new Date());
  const cpfClean = (customer.document?.number || customer.cpf || "").replace(/\D/g, "");
  const telClean = (customer.phone || "").replace(/\D/g, "");

  let transaction;
  try {
    transaction = await bcRequest("POST", "/sales/create-sale", {
      amount: amountCents,
      currency: "BRL",
      paymentMethod: "pix",
      externalRef: orderId,
      postbackUrl: SITE_URL.startsWith("https://") ? `${SITE_URL}/api/webhooks/blackcat` : undefined,
      items: items.map((i) => ({
        title: i.title || i.name || "Item",
        unitPrice: i.unitPrice || 0,  // já em centavos
        quantity: i.quantity || 1,
        tangible: false,
      })),
      customer: {
        name: customer.name,
        email: customer.email || "cliente@discrettasexshop.com.br",
        phone: telClean || "00000000000",
        document: { number: cpfClean || "00000000000", type: "cpf" },
      },
      pix: { expiresInDays: 1 },
      utm_source: tracking?.utm_source || null,
      utm_medium: tracking?.utm_medium || null,
      utm_campaign: tracking?.utm_campaign || null,
      utm_content: tracking?.utm_content || null,
      utm_term: tracking?.utm_term || null,
    });
  } catch (err) {
    console.error("BlackCat PIX error:", err.body || err.message);
    return res.status(502).json({ error: "Falha ao gerar PIX. Tente novamente." });
  }

  // BlackCat retorna paymentData.copyPaste e paymentData.qrCodeBase64
  const pixCode = transaction.paymentData?.copyPaste || "";
  const qrBase64 = transaction.paymentData?.qrCodeBase64 || null;

  // Usa QR da BlackCat se disponível, senão gera localmente
  let pixImage = qrBase64 || null;
  if (!pixImage && pixCode) {
    try {
      pixImage = await QRCode.toDataURL(pixCode, { width: 280, margin: 2 });
    } catch (e) {
      console.error("QR gen error:", e.message);
    }
  }

  // Envia "waiting_payment" para UTMify
  if (UTMIFY_TOKEN) {
    const clientIp = ((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "0.0.0.0").replace(/^::ffff:/, "");
    const utmProducts = items.map((i) => ({
      id: String(i.id || i.title || i.name),
      name: i.title || i.name || "Item",
      quantity: i.quantity || 1,
      priceInCents: i.unitPrice || 0,
    }));

    const utmPayload = buildUtmifyPayload({
      orderId: String(transaction.transactionId),
      status: "waiting_payment",
      createdAt,
      approvedDate: null,
      customer: { name: customer.name, phone: telClean || null, document: null, ip: clientIp },
      products: utmProducts,
      tracking: tracking || {},
      totalPriceInCents: amountCents,
    });
    await sendToUtmify(utmPayload);

    const pending = readPending();
    pending.push({ transactionId: String(transaction.transactionId), createdAt, utmPayload });
    writePending(pending);
  }

  return res.json({
    id: transaction.transactionId,
    pixCode,
    pixImage,
    expiresAt: transaction.paymentData?.expiresAt || null,
    amount: amountCents,
  });
});

// ── GET /api/status-pix ───────────────────────────────────────────────────────

app.get("/api/status-pix", async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id é obrigatório" });

  try {
    const tx = await bcRequest("GET", `/sales/${id}/status`);
    const paid = tx.status === "PAID";
    const finalizadoSemPagar = ["CANCELLED", "REFUNDED"].includes(tx.status);
    return res.json({ paid, finalizadoSemPagar, status: tx.status });
  } catch (err) {
    console.error("BlackCat status error:", err.body || err.message);
    return res.status(502).json({ error: "Falha ao consultar pagamento." });
  }
});

// ── POST /api/webhooks/blackcat ───────────────────────────────────────────────

const seenWebhooks = new Set();

app.post("/api/webhooks/blackcat", (req, res) => {
  res.json({ received: true });

  const event = req.body;
  const eventType = req.headers["x-webhook-event"] || "";
  const transactionId = String(event?.transactionId || event?.data?.transactionId || "");

  if (!transactionId || seenWebhooks.has(transactionId)) return;
  seenWebhooks.add(transactionId);

  setImmediate(async () => {
    console.log(`[webhook] event=${eventType} transactionId=${transactionId}`);

    const isPaid = eventType === "transaction.paid" || event?.status === "PAID";

    if (isPaid && UTMIFY_TOKEN) {
      const paidAt = event?.paidAt || event?.data?.paidAt;
      const approvedDate = paidAt ? toUtcDateTime(new Date(paidAt)) : toUtcDateTime(new Date());

      const pending = readPending();
      const row = pending.find((r) => r.transactionId === transactionId);
      if (row) {
        await sendToUtmify({ ...row.utmPayload, status: "paid", approvedDate });
        writePending(pending.filter((r) => r.transactionId !== transactionId));
      }
    }
  });
});

// ── GET /api/config-publico ───────────────────────────────────────────────────

app.get("/api/config-publico", (_req, res) => {
  res.json({ exists: false, temCupons: false });
});

// ── POST /api/cupom-validar ───────────────────────────────────────────────────

app.post("/api/cupom-validar", (req, res) => {
  const { codigo } = req.body;
  const cupons = {
    DISCRETTA10: { desconto: 0.10, tipo: "percentual" },
  };
  const cupom = cupons[(codigo || "").toUpperCase()];
  if (!cupom) {
    return res.json({ valido: false, motivo: "Cupom inválido ou expirado." });
  }
  const subtotalCents = req.body.subtotalCents || 0;
  const descontoCents = cupom.tipo === "percentual"
    ? Math.round(subtotalCents * cupom.desconto)
    : cupom.valor * 100;
  return res.json({ valido: true, codigo: (codigo || "").toUpperCase(), descontoCents });
});

// ── Polling fallback UTMify ───────────────────────────────────────────────────

async function pollPending() {
  if (!UTMIFY_TOKEN || !BC_KEY) return;
  const pending = readPending();
  if (!pending.length) return;

  const stillPending = [];
  for (const row of pending) {
    try {
      const tx = await bcRequest("GET", `/sales/${row.transactionId}/status`);
      if (tx.status === "PAID") {
        const paidAt = tx.paidAt;
        const approvedDate = paidAt ? toUtcDateTime(new Date(paidAt)) : toUtcDateTime(new Date());
        await sendToUtmify({ ...row.utmPayload, status: "paid", approvedDate });
        console.log(`UTMify polling: ${row.transactionId} confirmado`);
      } else {
        stillPending.push(row);
      }
    } catch (err) {
      console.error("Poll error:", row.transactionId, err.message);
      stillPending.push(row);
    }
  }
  if (stillPending.length !== pending.length) writePending(stillPending);
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Discretta Sex Shop rodando na porta ${PORT}`);
  console.log(`BlackCat: ${BC_BASE}`);
  if (UTMIFY_TOKEN) {
    console.log("UTMify: ativo — pedidos serão enviados ao painel.");
    setInterval(pollPending, POLL_INTERVAL_MS);
    pollPending();
  } else {
    console.warn("UTMify: UTMIFY_API_TOKEN não configurado — tracking desativado.");
  }
});
