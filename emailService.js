import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const env = (name, fallback = '') => {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return String(v);
};

const sendEmailViaResend = async ({ to, subject, html, text, headers = {} }) => {
  const apiKey = env('RESEND_API_KEY');
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY missing' };

  const fromEmail = env('EMAIL_FROM_EMAIL', env('MAILJET_SENDER_EMAIL', 'info@alluvi.org'));
  const fromNameRaw = env('EMAIL_FROM_NAME', env('MAILJET_SENDER_NAME', 'Team Alluvi'));
  const fromName = /klyme/i.test(fromNameRaw) ? 'Alluvi' : fromNameRaw;

  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject,
    html,
    ...(text ? { text } : {}),
    ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {}),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || `Resend send failed (${res.status})`;
    return { success: false, error: msg, details: data };
  }

  const messageId = data?.id || data?.data?.id;
  return { success: true, messageId };
};

const sendEmailViaMailjet = async ({ to, subject, html, text, inlineAttachments = [], headers = {} }) => {
  const apiKey = env('MAILJET_API_KEY');
  const secretKey = env('MAILJET_SECRET_KEY');
  const fromEmail = env('MAILJET_SENDER_EMAIL');
  const fromNameRaw = env('MAILJET_SENDER_NAME', 'Alluvi');
  const fromName = /klyme/i.test(fromNameRaw) ? 'Alluvi' : fromNameRaw;

  if (!apiKey || !secretKey || !fromEmail) {
    return { success: false, error: 'MAILJET credentials missing' };
  }

  const payload = {
    Messages: [
      {
        From: { Email: fromEmail, Name: fromName },
        To: [{ Email: to }],
        Subject: subject,
        HTMLPart: html,
        ...(text ? { TextPart: text } : {}),
        ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { Headers: headers } : {}),
        ...(Array.isArray(inlineAttachments) && inlineAttachments.length ? { InlinedAttachments: inlineAttachments } : {})
      }
    ]
  };

  const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.ErrorMessage || data?.error || `Mailjet send failed (${res.status})`;
    return { success: false, error: msg, details: data };
  }

  const messageId = data?.Messages?.[0]?.To?.[0]?.MessageID || data?.Messages?.[0]?.MessageID;
  return { success: true, messageId };
};

const createTransporter = () => {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER || 'your-email@gmail.com',
      pass: process.env.EMAIL_PASS || 'your-app-password'
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
};

const ALLUVI_LOGO_CID = 'alluvilogo.png';

const resolveAlluviLogoPath = () => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.join(__dirname, '..', '..', 'public', 'images', 'Alluvi-logo-2-white.png');
  } catch {
    return '';
  }
};

const hasAlluviLogoFile = () => {
  try {
    const p = resolveAlluviLogoPath();
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

const getAlluviLogoInlineAttachmentForMailjet = () => {
  try {
    const filePath = resolveAlluviLogoPath();
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return {
      ContentType: 'image/png',
      Filename: 'alluvilogo.png',
      Base64Content: buf.toString('base64'),
      ContentID: ALLUVI_LOGO_CID,
    };
  } catch {
    return null;
  }
};

const getAlluviLogoInlineAttachmentForNodemailer = () => {
  try {
    const filePath = resolveAlluviLogoPath();
    if (!filePath || !fs.existsSync(filePath)) return null;
    return {
      filename: 'alluvilogo.png',
      path: filePath,
      cid: ALLUVI_LOGO_CID,
      contentType: 'image/png',
    };
  } catch {
    return null;
  }
};

const HAS_SUBSCRIPTION_PACKS = [
  {
    name: 'Track Essentials',
    bestFor: 'Basic tracking & oversight',
    includes: 'Live tracking & trip history; monitoring & alerts; core reporting',
    price: 89.99,
  },
  {
    name: 'DriverSafe',
    bestFor: 'Reduce risky driving',
    includes: 'Driver behaviour; driver scoring; speed monitoring & alerts',
    price: 119.99,
  },
  {
    name: 'VehicleCare',
    bestFor: 'Cut breakdowns & downtime',
    includes: 'Vehicle health/diagnostics; maintenance alerts; monitoring',
    price: 129.99,
  },
  {
    name: 'Route+Deliver',
    bestFor: 'Dispatch + delivery visibility',
    includes: 'Route planning; delivery proofs; dispatch board; customer notifications',
    price: 219.99,
  },
  {
    name: 'Rental Guard',
    bestFor: 'Rental & leasing fleets',
    includes: 'Rental controls; protection/compliance; monitoring & analytics',
    price: 169.99,
  },
  {
    name: 'SpeedSense Elite',
    bestFor: 'Fines & compliance-heavy fleets',
    includes: 'Fines workflow; evidence/enforcement; liability reduction',
    price: 219.99,
  },
];

const IBALTICX_PRODUCTS = [
  { description: 'Gaming Mouse', price: 89.99 },
  { description: 'Gaming Keyboard', price: 219.99 },
  { description: 'Corporate Headphones', price: 119.99 },
  { description: 'Bluetooth speaker', price: 129.99 },
  { description: 'Smartphone accesories pack', price: 139.99 },
  { description: 'Earbuds', price: 169.99 },
];

// Product name mapping for IBALTICX (IVMS) - maps Alluvi product names to HAS subscription packs
const IBALTICX_PRODUCT_NAME_MAP = [
  { needle: 'glow 70mg', pack: 'Track Essentials' },
  { needle: 'bpc-157 & tb-500 40mg', pack: 'VehicleCare' },
  { needle: 'retatrutide 20mg', pack: 'Route+Deliver' },
  { needle: 'nad+ 1,000mg', pack: 'Rental Guard' },
  { needle: 'nad+ 1000mg', pack: 'Rental Guard' },
  { needle: 'tirzepatide 40mg', pack: 'DriverSafe' },
  { needle: 'retatrutide 40mg', pack: 'SpeedSense Elite' },
  { needle: 'bpc-157 5mg', pack: 'Track Essentials' },
  { needle: 'bpc-157 10mg', pack: 'Track Essentials' },
  { needle: 'tb-500 5mg', pack: 'Track Essentials' },
  { needle: 'tb-500 10mg', pack: 'Track Essentials' },
  { needle: 'semaglutide', pack: 'DriverSafe' },
  { needle: 'tirzepatide', pack: 'DriverSafe' },
  { needle: 'retatrutide', pack: 'Route+Deliver' },
  { needle: 'nad+', pack: 'Rental Guard' },
  { needle: 'glow', pack: 'Track Essentials' },
];

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

const normalizeForMatch = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9+&,.()\- ]/g, '')
    .trim();

const HAS_PRODUCT_TO_PACK = [
  { needle: 'glow 70mg', pack: 'Track Essentials' },
  { needle: 'bpc-157 & tb-500 40mg', pack: 'VehicleCare' },
  { needle: 'retatrutide 20mg', pack: 'Route+Deliver' },
  { needle: 'nad+ 1,000mg', pack: 'Rental Guard' },
  { needle: 'nad+ 1000mg', pack: 'Rental Guard' },
  { needle: 'tirzepatide 40mg', pack: 'DriverSafe' },
  { needle: 'retatrutide 40mg', pack: 'SpeedSense Elite' },
];

const findPackByName = (rawProductName) => {
  const n = normalizeForMatch(rawProductName);
  if (!n) return null;
  const hit = HAS_PRODUCT_TO_PACK.find((x) => n.includes(normalizeForMatch(x.needle)));
  if (!hit) return null;
  return HAS_SUBSCRIPTION_PACKS.find((p) => p.name === hit.pack) || null;
};

export const buildHasInvoiceMaskedItems = ({ orderItems = [], promoDiscountPercent, expectedTotal }) => {
  const list = Array.isArray(orderItems) ? orderItems : [];
  const pct = Number(promoDiscountPercent || 0);
  const factor = pct > 0 ? (100 - pct) / 100 : 1;

  const findPackByPrice = (unitPrice) => {
    const p = round2(unitPrice);
    const direct = HAS_SUBSCRIPTION_PACKS.find((x) => Math.abs(round2(x.price) - p) <= 0.01) || null;
    if (direct) return direct;
    // If prices were discounted (promo), try matching against the pre-discount unit price.
    if (factor > 0 && factor < 1) {
      const base = round2(p / factor);
      return HAS_SUBSCRIPTION_PACKS.find((x) => Math.abs(round2(x.price) - base) <= 0.01) || null;
    }
    return null;
  };

  const items = list
    .map((it) => {
      const qty = Math.max(1, Number(it?.quantity || it?.qty || 1));
      const unit = Number(it?.unit_price ?? it?.unitPrice ?? it?.rate ?? 0);
      const pack = findPackByName(it?.name) || findPackByPrice(unit);
      const description = pack ? String(pack.name) : String(it?.name || it?.description || 'IVMS software subscription');
      // For HAS invoices we show pre-discount rates/amounts and apply the promo as a separate line.
      // If promo is active and unit looks discounted, recover original by dividing by factor.
      // If unit already equals the base pack price, keep it.
      const recoveredUnit = factor > 0 && factor < 1 ? round2(unit / factor) : round2(unit);
      const packPrice = pack && Number.isFinite(Number(pack.price)) ? round2(Number(pack.price)) : null;
      const baseUnit = (packPrice !== null && Math.abs(round2(unit) - packPrice) <= 0.01)
        ? packPrice
        : recoveredUnit;
      const amount = round2(baseUnit * qty);
      return { description, qty, rate: baseUnit, amount };
    })
    .filter((x) => x.qty > 0);

  const subtotal = round2(items.reduce((sum, x) => sum + Number(x.amount || 0), 0));
  const exp = typeof expectedTotal !== 'undefined' ? round2(expectedTotal) : null;
  // Do not force-adjust subtotal to expectedTotal when promo is present; expectedTotal is typically AFTER discount.
  // We keep subtotal as pre-discount and let the template apply the discount line.
  return { items, subtotal, total: exp !== null ? exp : subtotal };
};

export const buildIbalticxMaskedItems = ({ orderItems = [], promoDiscountPercent, expectedTotal }) => {
  const list = Array.isArray(orderItems) ? orderItems : [];
  const pct = Number(promoDiscountPercent || 0);
  const factor = pct > 0 ? (100 - pct) / 100 : 1;

  const findByName = (rawProductName) => {
    const n = normalizeForMatch(rawProductName);
    if (!n) return null;
    const hit = IBALTICX_PRODUCT_NAME_MAP.find((x) => n.includes(normalizeForMatch(x.needle)));
    if (!hit) return null;
    return HAS_SUBSCRIPTION_PACKS.find((p) => p.name === hit.pack) || null;
  };

  const findByPrice = (unitPrice) => {
    const p = round2(unitPrice);
    const direct = HAS_SUBSCRIPTION_PACKS.find((x) => Math.abs(round2(x.price) - p) <= 0.01) || null;
    if (direct) return direct;
    if (factor > 0 && factor < 1) {
      const base = round2(p / factor);
      return HAS_SUBSCRIPTION_PACKS.find((x) => Math.abs(round2(x.price) - base) <= 0.01) || null;
    }
    return null;
  };

  const items = list
    .map((it) => {
      const qty = Math.max(1, Number(it?.quantity || it?.qty || 1));
      const unit = Number(it?.unit_price ?? it?.unitPrice ?? it?.rate ?? 0);
      // Try name mapping first, then fall back to price matching
      const pack = findByName(it?.name) || findByPrice(unit);
      const description = pack ? String(pack.name) : String(it?.name || it?.description || 'IVMS software subscription');
      const recoveredUnit = factor > 0 && factor < 1 ? round2(unit / factor) : round2(unit);
      const packPrice = pack && Number.isFinite(Number(pack.price)) ? round2(Number(pack.price)) : null;
      const baseUnit = (packPrice !== null && Math.abs(round2(unit) - packPrice) <= 0.01)
        ? packPrice
        : (packPrice !== null ? packPrice : recoveredUnit);
      const amount = round2(baseUnit * qty);
      return { description, qty, rate: baseUnit, amount };
    })
    .filter((x) => x.qty > 0);

  const subtotal = round2(items.reduce((sum, x) => sum + Number(x.amount || 0), 0));
  const exp = typeof expectedTotal !== 'undefined' ? round2(expectedTotal) : null;
  return { items, subtotal, total: exp !== null ? exp : subtotal };
};

// Beautiful email template with inline styles
const getEmailTemplate = (type, data) => {
  const baseStyle = '';
  let content = '';

  const hasLogo = hasAlluviLogoFile();
  const headerLogoHtml = hasLogo
    ? `<img src="cid:${ALLUVI_LOGO_CID}" alt="Alluvi" style="display:inline-block;height:52px;width:auto;" />`
    : `<h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>`;

  const safeText = (v, fallback = '') => {
    if (v === undefined || v === null) return fallback;
    const s = String(v);
    if (!s) return fallback;
    if (s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return fallback;
    return s;
  };

  switch (type) {
    case 'order_confirmation':
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 700; color: #1a1a1a; margin: 0 0 25px 0; line-height: 1.3;">Thank you for your order request with Alluvi!</h2>
            
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 15px 0;">Hi ${safeText(data.customerName, 'Customer')},</p>
            
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 12px 0;">This email is your official order request receipt and confirmation.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 22px 0;"><strong>No payment has been taken yet.</strong></p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 12px 0;">Next step : you will receive a second email containing your secure payment link and simple instructions on how to pay.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 22px 0;">Please keep an eye on your inbox and also check the Spam/Junk folder.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 25px 0;">Once your payment is completed and confirmed, your order will move to shipping. Thank you for shopping with us.</p>

            <div style="height: 1px; background: linear-gradient(90deg, transparent 0%, #e9ecef 50%, transparent 100%); margin: 30px 0;"></div>

            <h3 style="margin-top: 30px; color: #1a1a1a; font-size: 20px; margin-bottom: 20px;">Order details</h3>
            
            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 25px; margin: 25px 0; border-radius: 8px;">
              <div style="margin-bottom: 15px;">
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">Order number</div>
                <div style="font-size: 18px; font-weight: 700; color: #1a1a1a;">${data.orderNumber}</div>
              </div>
              
              ${(Array.isArray(data.items) ? data.items : []).map(item => `
                <div style="margin-bottom: 15px;">
                  <div style="font-size: 14px; color: #666; margin-bottom: 5px;">Product</div>
                  <div style="font-size: 16px; font-weight: 600; color: #1a1a1a;">${safeText(item?.name, '')}</div>
                </div>
                
                <div style="margin-bottom: 15px;">
                  <div style="font-size: 14px; color: #666; margin-bottom: 5px;">Quantity</div>
                  <div style="font-size: 16px; font-weight: 600; color: #1a1a1a;">${Number(item?.quantity || 0)}</div>
                </div>
              `).join('')}
              
              <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e9ecef;">
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">Total paid</div>
                <div style="font-size: 22px; font-weight: 700; color: #FF8200;">£${data.total.toFixed(2)}</div>
              </div>
            </div>

            <div style="height: 1px; background: linear-gradient(90deg, transparent 0%, #e9ecef 50%, transparent 100%); margin: 30px 0;"></div>

            <h3 style="margin-top: 30px; color: #1a1a1a; font-size: 20px; margin-bottom: 20px;">Shipping method</h3>
            
            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 25px; margin: 25px 0; border-radius: 8px;">
              <div style="margin-bottom: 10px;">
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">Service</div>
                <div style="font-size: 16px; font-weight: 600; color: #1a1a1a;">Royal Mail</div>
              </div>
            </div>

            <div style="height: 1px; background: linear-gradient(90deg, transparent 0%, #e9ecef 50%, transparent 100%); margin: 30px 0;"></div>

            <h3 style="margin-top: 30px; color: #1a1a1a; font-size: 20px; margin-bottom: 20px;">Shipping address</h3>
            
            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 25px; margin: 25px 0; border-radius: 8px;">
              <p style="margin: 0; line-height: 1.8; color: #1a1a1a; font-size: 16px;">
                <strong>${safeText(data.customerName, 'Customer')}</strong><br>
                ${safeText(data.shippingAddress, '-') }<br>
                ${safeText(data.shippingCity, '-') }<br>
                ${safeText(data.shippingZip, '-') }<br>
                ${safeText(data.shippingCountry, '-') }
              </p>
            </div>
            
            <div style="height: 1px; background: linear-gradient(90deg, transparent 0%, #e9ecef 50%, transparent 100%); margin: 30px 0;"></div>
            
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> 2024 Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For any questions, please contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;

    case 'klyme_payment_successful': {
      const name = String(data?.customerName || '').trim() || 'there';
      const orderNumber = String(data?.orderNumber || '').trim();
      const amount = Number(data?.amount || data?.total || 0);
      const currency = String(data?.currency || 'GBP').trim() || 'GBP';
      const publicBase = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || 'https://www.alluvi.org').replace(/\/$/, '');
      const trackUrl = String(data?.trackUrl || `${publicBase}/track-order`).trim();
      
      // Get order date from data or use current date
      const orderDate = data?.orderDate ? new Date(data.orderDate) : new Date();
      const dayOfWeek = orderDate.getDay(); // 0 = Sunday, 5 = Friday
      const hour = orderDate.getHours();
      const isBefore2PM = hour < 14;
      
      // Determine delivery text based on day and time logic
      let deliveryText;
      if (dayOfWeek === 5) {
        // Friday
        if (isBefore2PM) {
          deliveryText = 'Your payment has been approved and your order is now being prepared for shipping. Orders placed before 2PM on Friday are shipped Saturday or Monday.';
        } else {
          deliveryText = 'Your payment has been approved and your order is now being prepared for shipping. Orders placed after 2PM on Friday are shipped Monday or Tuesday.';
        }
      } else {
        // Monday - Thursday
        if (isBefore2PM) {
          deliveryText = 'Your payment has been approved and your order is now being prepared for shipping. Orders placed before 2PM are shipped next business day.';
        } else {
          deliveryText = 'Your payment has been approved and your order is now being prepared for shipping. Orders placed after 2PM are shipped day after next working day.';
        }
      }

      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Payment Successful</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Your payment is confirmed</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Hi ${name},</p>
            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">${deliveryText}</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 18px 0 22px 0; border-radius: 8px;">
              <div style="font-size: 14px; line-height: 1.7; color: #4a4a4a; margin: 0;">
                Orders are typically processed within 2 working days. Once your order is dispatched, you will receive a separate email with your tracking details. Please keep an eye on your inbox (and spam/junk folder) for updates.
              </div>
            </div>

            <div style="background: #f8f9fa; border-left: 4px solid #00d4aa; padding: 22px; margin: 22px 0; border-radius: 8px;">
              ${orderNumber ? `
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                  <div style="font-size: 18px; font-weight: 900; color: #1a1a1a;">${orderNumber}</div>
                </div>
              ` : ''}
              <div style="margin-bottom: 12px;">
                <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Amount</div>
                <div style="font-size: 20px; font-weight: 900; color: #00b894;">£${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'} ${currency}</div>
              </div>
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 14px 0;">You can track your order status at any time from the Track Order page.</p>

            <div style="text-align: center; margin: 22px 0 0; display: flex; flex-direction: column; gap: 12px; align-items: center;">
              <a href="${trackUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Open Track Order</a>
              <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Alluvi Support</a>
            </div>

            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0;">If you need help, you can message us on Live Chat from the official website <strong>Alluvi usa</strong>.</p>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'payment_processor': {
      const name = String(data?.customerName || '').trim() || 'there';
      const orderNumber = String(data?.orderNumber || '').trim();
      const total = Number(data?.total || 0);
      const currency = String(data?.currency || 'GBP').trim() || 'GBP';
      const trackUrl = String(data?.trackUrl || 'https://www.alluvi.org/track-order').trim();
      const website = String(data?.website || 'https://www.alluvi.org').trim();

      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Secure Card Payment</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Complete your payment</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Hi ${name},</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Your order was created using our secure payment processor.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              ${orderNumber ? `
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                  <div style="font-size: 18px; font-weight: 900; color: #1a1a1a;">${orderNumber}</div>
                </div>
              ` : ''}
              <div>
                <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Amount</div>
                <div style="font-size: 20px; font-weight: 900; color: #FF8200;">£${Number.isFinite(total) ? total.toFixed(2) : '0.00'} ${currency}</div>
              </div>
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">If your payment was not completed, you can continue from the Track Order page.</p>

            <div style="text-align: center; margin: 26px 0;">
              <a href="${trackUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Open Track Order</a>
            </div>

            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0;">Need help? Use Live Chat on <a href="${website}" style="color:#FF8200; text-decoration:none; font-weight:800;">Alluvi usa</a> for assistance.</p>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'delivery_information': {
      const name = String(data?.customerName || '').trim() || 'there';
      const orderNumber = String(data?.orderNumber || '').trim();
      const deliveryText = String(data?.deliveryText || '').trim();
      const deliveryDateLabel = String(data?.deliveryDateLabel || '').trim();
      const trackUrl = String(data?.trackUrl || 'https://www.alluvi.org/track-order').trim();

      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Delivery Information</p>
          </div>

          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Delivery timing & tracking</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Hi ${name},</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              ${orderNumber ? `
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                  <div style="font-size: 18px; font-weight: 900; color: #1a1a1a;">${orderNumber}</div>
                </div>
              ` : ''}

              ${deliveryText ? `
                <div style="margin: 0; padding: 14px 14px; background: rgba(255, 130, 0, 0.06); border: 1px solid rgba(255, 130, 0, 0.25); border-radius: 10px;">
                  <div style="font-size: 12px; font-weight: 800; color: #a14f00; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Delivery estimate</div>
                  <div style="font-size: 14px; line-height: 1.7; color: #4a4a4a; margin: 0;"><strong>${deliveryText}</strong></div>
                  ${deliveryDateLabel ? `<div style="margin-top: 8px; font-size: 13px; color: #444;">Expected: <strong>${deliveryDateLabel}</strong></div>` : ''}
                </div>
              ` : ''}
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 12px 0;">Your tracking number will be sent in the evening of the day its shipped out in a seperate email, you'll also find it on track-order page on the alluvi website.</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">You can also track your order in the Track Order page.</p>

            <div style="text-align: center; margin: 22px 0;">
              <a href="${trackUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Track your order</a>
            </div>

            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0;">If you need help, you can message us on Live Chat from the official website <strong>Alluvi usa</strong>.</p>

            <div style="text-align: center; margin: 16px 0 0;">
              <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Alluvi Support</a>
            </div>
          </div>

          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For help, contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'klyme_payment_rejected': {
      const name = String(data?.customerName || '').trim() || 'there';
      const orderNumber = String(data?.orderNumber || '').trim();
      const reason = String(data?.reason || '').trim();
      const trackUrl = String(data?.trackUrl || 'https://www.alluvi.org/track-order').trim();

      content = `
        <div style="background: #f3f3f3; padding: 24px 14px;">
          <div style="max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 6px 22px rgba(0,0,0,0.10); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <div style="background: #FF8200; padding: 44px 40px; text-align: center;">
              ${headerLogoHtml}
              <p style="font-size: 12px; font-style: italic; color: rgba(255,255,255,0.92); margin: 10px 0 0 0;">Payment Rejected</p>
            </div>

            <div style="padding: 42px 40px 30px 40px;">
              <h2 style="font-size: 28px; font-weight: 900; color: #111; margin: 0 0 16px 0; line-height: 1.2;">We couldn’t confirm your payment</h2>
              <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0 0 12px 0;">Hi ${name},</p>

              <p style="font-size: 13px; line-height: 1.7; color: #666; margin: 0 0 16px 0;">Your payment was not successful with our payment processor.</p>

              <div style="background: #fafafa; border-left: 4px solid #ef4444; padding: 18px 18px; margin: 18px 0; border-radius: 8px;">
                ${orderNumber ? `
                  <div style="margin-bottom: 10px;">
                    <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                    <div style="font-size: 14px; font-weight: 900; color: #111;">${orderNumber}</div>
                  </div>
                ` : ''}
                ${reason ? `
                  <div>
                    <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Details</div>
                    <div style="font-size: 13px; color: #111; line-height: 1.7;">${reason}</div>
                  </div>
                ` : ''}
              </div>

              <p style="font-size: 12px; line-height: 1.7; color: #666; margin: 0 0 18px 0;">You can track your order status and attempt checkout again from the Track Order page.</p>

              <div style="text-align: center; margin: 18px 0 22px;">
                <a href="${trackUrl}" style="display: inline-block; background: #FF8200; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 900; font-size: 13px;">Open Track Order</a>
              </div>

              <p style="font-size: 12px; line-height: 1.7; color: #777; margin: 0;">If you did not place this order, you can safely ignore this email.</p>
            </div>

            <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 34px 24px; text-align: center;">
              <p style="font-size: 11px; color: #aaa; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
              <p style="font-size: 11px; color: #aaa; margin: 8px 0;">For help, contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none; font-weight: 800;">Alluvi usa</a>.</p>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case 'ibalticx':
      const ibDate = data?.invoiceDate || '24 Dec 2025';
      const ibInvoiceNumberRaw = data?.invoiceNumber || 'INV-1092';
      const ibInvoiceNumber = String(ibInvoiceNumberRaw)
        .replace(/^INV-ALU-/i, 'INV-')
        .replace(/^INV-ALU/i, 'INV-');
      const ibBillToName = data?.billToName || 'Customer';
      const ibBillToAddressLine1 = data?.billToAddressLine1 || '';
      const ibBillToAddressLine2 = data?.billToAddressLine2 || '';

      const ibSenderCompanyName = data?.senderCompanyName || 'Ibalticx';
      const ibSenderAddressLines = data?.senderAddressLines || [
        'Ibalticx',
        'United Kingdom',
      ];
      const ibSenderWebsite = data?.senderWebsite || 'ibalticx.com';
      const ibSenderTaxNumber = data?.senderTaxNumber || '';
      const ibSenderEmail = data?.senderEmail || 'support@ibalticx.com';

      const ibItems = Array.isArray(data?.items) && data.items.length
        ? data.items
        : [
            { description: 'Gaming Mouse', qty: 1, rate: 89.99, amount: 89.99 }
          ];

      const ibFormatMoney = (n) => {
        const num = Number(n || 0);
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };

      const ibPreDiscountSubtotal = ibItems.reduce(
        (sum, it) => sum + Number(it?.amount ?? (Number(it?.qty || 0) * Number(it?.rate || 0))),
        0
      );
      const ibTotalFromPayload = typeof data?.total !== 'undefined' ? Number(data.total || 0) : null;

      const ibPromoCode = String(data?.promoCode || data?.promo_code || '').trim();
      const ibPromoDiscountPercentRaw = Number(data?.promoDiscountPercent ?? data?.promo_discount_percent ?? 0);
      const ibPromoDiscountPercent = Number.isFinite(ibPromoDiscountPercentRaw) && ibPromoDiscountPercentRaw > 0 ? ibPromoDiscountPercentRaw : 0;
      const ibDiscountAmountRaw = Number(data?.discountAmount ?? data?.discount_amount ?? 0);
      const ibDiscountAmountFromPayload = Number.isFinite(ibDiscountAmountRaw) && ibDiscountAmountRaw > 0 ? ibDiscountAmountRaw : 0;

      const ibHasPromo = !!ibPromoCode || ibPromoDiscountPercent > 0 || ibDiscountAmountFromPayload > 0;
      const ibPreSubtotalRounded = round2(ibPreDiscountSubtotal);
      const ibDiscountFromTotals = (
        ibHasPromo && Number.isFinite(ibTotalFromPayload) && ibTotalFromPayload !== null
      ) ? round2(ibPreSubtotalRounded - Number(ibTotalFromPayload || 0)) : 0;

      const ibComputedDiscountAmount = ibHasPromo
        ? (ibDiscountFromTotals > 0
          ? ibDiscountFromTotals
          : (ibDiscountAmountFromPayload > 0
            ? ibDiscountAmountFromPayload
            : (ibPromoDiscountPercent > 0 ? round2(ibPreSubtotalRounded * (ibPromoDiscountPercent / 100)) : 0)))
        : 0;

      const ibComputedAfterDiscountTotal = ibHasPromo
        ? round2(ibPreSubtotalRounded - Number(ibComputedDiscountAmount || 0))
        : ibPreSubtotalRounded;

      const ibAfterDiscountTotal = ibHasPromo
        ? (ibDiscountFromTotals > 0 && Number.isFinite(ibTotalFromPayload) ? Number(ibTotalFromPayload || 0) : ibComputedAfterDiscountTotal)
        : (Number.isFinite(ibTotalFromPayload) ? Number(ibTotalFromPayload || 0) : ibPreSubtotalRounded);

      const ibBankName = data?.bank?.bankName || 'Openpayd Financial Services - CP - GBP';
      const ibBankAddress = data?.bank?.bankAddress || 'Pangea, Level 5, Triq San Gorg, St. Julians STJ 3204, United Kingdom';
      const ibBankAccountNumber = data?.bank?.accountNumber || '02207055';
      const ibBankSortCode = data?.bank?.sortCode || '040511';
      const ibBankBeneficiaryName = data?.bank?.beneficiaryName || 'UAB iBaltic X';

      content = `
        <div style="max-width: 720px; margin: 0 auto; padding: 24px 18px; background: #ffffff; color: #111; font-family: Arial, Helvetica, sans-serif;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="vertical-align: top; padding: 0;">
                <div style="font-size: 32px; font-weight: 800; letter-spacing: 1px; margin-top: 28px;">INVOICE</div>
              </td>
              <td style="vertical-align: top; padding: 0; text-align: right;"></td>
            </tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 22px;">
            <tr>
              <td style="vertical-align: top; width: 46%; padding-right: 10px;">
                <div style="font-size: 11px; font-weight: 700; margin-bottom: 8px;">${ibBillToName}</div>
                <div style="font-size: 11px; line-height: 1.5;">
                  ${ibBillToAddressLine1 ? `<div>${ibBillToAddressLine1}</div>` : ''}
                  ${ibBillToAddressLine2 ? `<div>${ibBillToAddressLine2}</div>` : ''}
                </div>
              </td>

              <td style="vertical-align: top; width: 20%; padding-left: 10px; padding-right: 10px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; font-size: 11px; line-height: 1.7;">
                  <tr>
                    <td style="font-weight: 700; padding: 0 0 2px 0;">Invoice Date</td>
                  </tr>
                  <tr>
                    <td style="padding: 0 0 10px 0;">${ibDate}</td>
                  </tr>
                  <tr>
                    <td style="font-weight: 700; padding: 0 0 2px 0;">Invoice Number</td>
                  </tr>
                  <tr>
                    <td style="padding: 0;">${ibInvoiceNumber}</td>
                  </tr>
                </table>
              </td>

              <td style="vertical-align: top; width: 34%; padding-left: 10px;">
                <div style="font-size: 11px; line-height: 1.7; text-align: right;">
                  <div style="font-weight: 700;">${ibSenderCompanyName}</div>
                  ${(Array.isArray(ibSenderAddressLines) ? ibSenderAddressLines : []).map((l) => `<div>${String(l || '')}</div>`).join('')}
                  ${ibSenderTaxNumber ? `<div>Tax Registration Number</div><div>${ibSenderTaxNumber}</div>` : ''}
                  ${ibSenderEmail ? `<div>Email:</div><div>${ibSenderEmail}</div>` : ''}
                </div>
              </td>
            </tr>
          </table>

          <div style="margin-top: 56px;">
            <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; font-size: 11px;">
              <thead>
                <tr>
                  <th style="text-align: left; font-weight: 700; padding: 8px 6px; border-bottom: 1px solid #cfcfcf;">Description</th>
                  <th style="text-align: center; font-weight: 700; padding: 8px 6px; border-bottom: 1px solid #cfcfcf; width: 70px;">Qty</th>
                  <th style="text-align: center; font-weight: 700; padding: 8px 6px; border-bottom: 1px solid #cfcfcf; width: 70px;">Rate</th>
                  <th style="text-align: right; font-weight: 700; padding: 8px 6px; border-bottom: 1px solid #cfcfcf; width: 130px;">Amount GBP</th>
                </tr>
              </thead>
              <tbody>
                ${(Array.isArray(ibItems) ? ibItems : []).map((it) => {
                  const qty = Number(it?.qty || 0);
                  const rate = Number(it?.rate || 0);
                  const amount = Number(it?.amount ?? (qty * rate));
                  return `
                    <tr>
                      <td style="padding: 10px 6px; border-bottom: 1px solid #e0e0e0;">${String(it?.description || '').replace(/\n/g, '<br/>')}</td>
                      <td style="padding: 10px 6px; text-align: center; border-bottom: 1px solid #e0e0e0;">${qty}</td>
                      <td style="padding: 10px 6px; text-align: center; border-bottom: 1px solid #e0e0e0;">${rate ? ibFormatMoney(rate) : ''}</td>
                      <td style="padding: 10px 6px; text-align: right; border-bottom: 1px solid #e0e0e0;">${ibFormatMoney(amount)}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 18px;">
              <tr>
                <td style="width: 55%;"></td>
                <td style="width: 45%;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <tr>
                      <td style="padding: 10px 0; border-top: 1px solid #cfcfcf; text-align: right;">Subtotal</td>
                      <td style="padding: 10px 0; border-top: 1px solid #cfcfcf; text-align: right; width: 140px;">${ibFormatMoney(ibAfterDiscountTotal)}</td>
                    </tr>
                    ${ibHasPromo ? `
                      <tr>
                        <td style="padding: 10px 0; text-align: right;">Promo code${ibPromoCode ? `: ${ibPromoCode}` : ''}${ibPromoDiscountPercent ? ` (${ibPromoDiscountPercent}% off)` : ''}</td>
                        <td style="padding: 10px 0; text-align: right; width: 140px;">-${ibFormatMoney(ibComputedDiscountAmount)}</td>
                      </tr>
                    ` : ''}
                    <tr>
                      <td style="padding: 12px 0 10px; border-top: 2px solid #111; text-align: right; font-weight: 800;">TOTAL GBP</td>
                      <td style="padding: 12px 0 10px; border-top: 2px solid #111; text-align: right; font-weight: 800; width: 140px;">${ibFormatMoney(ibAfterDiscountTotal)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </div>

          <div style="margin-top: 34px; font-size: 11px; line-height: 1.9;">
            <div style="font-weight: 800; margin-bottom: 10px;">Remit Payment To:</div>
            <div><strong>Bank name:</strong> ${ibBankName}</div>
            <div><strong>Bank address:</strong> ${ibBankAddress}</div>
            <div><strong>Account:</strong> ${ibBankAccountNumber}</div>
            <div><strong>Sort code:</strong> ${ibBankSortCode}</div>
            <div><strong>Beneficiary name:</strong> ${ibBankBeneficiaryName}</div>
          </div>
        </div>
      `;
      break;

    case 'payment_reminder': {
      const cutoffText = String(data?.cutoffText || '').trim() || 'If you pay before 2PM today, you will get the delivery tomorrow.';
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Payment Reminder</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 700; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Final step: complete your payment</h2>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Hi ${String(data?.customerName || '').trim() || 'there'},</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">This is a friendly reminder that your order is still awaiting payment confirmation. Once payment is completed, we can move your order straight into processing.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              <div style="margin-bottom: 12px;">
                <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                <div style="font-size: 18px; font-weight: 800; color: #1a1a1a;">${String(data?.orderNumber || '').trim()}</div>
              </div>
              ${typeof data?.total !== 'undefined' ? `
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Amount</div>
                  <div style="font-size: 20px; font-weight: 800; color: #FF8200;">£${Number(data?.total || 0).toFixed(2)} ${data?.currency || 'GBP'}</div>
                </div>
              ` : ''}
              <div style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.7; color: #666;">
                If you are unsure about this email integrity, please contact us via Live Chat on Alluvi usa
              </div>
              <div style="margin: 0; font-size: 13px; line-height: 1.7; color: #666;">
                Orders are typically processed within 2 working days. Once your order is dispatched, you will receive a separate email with your tracking details. Please keep an eye on your inbox (and spam/junk folder) for updates.
              </div>
            </div>

            <div style="text-align: center; margin: 26px 0 0; display: flex; flex-direction: column; gap: 12px; align-items: center;">
              <a href="${String(data?.paymentLink || '').trim()}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 700; font-size: 16px;">Open Secure Payment Page</a>
              <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Support</a>
            </div>

            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0 0 12px 0;">For your security, please only use the official Alluvi payment page from <strong>www.alluvi.org</strong>.</p>
            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0;">If you’ve already paid, you can ignore this message — our system will update your order automatically once verified.</p>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'customer_info':
      const customerInfoName = String(data?.customerName || '').trim();
      const trackUrl = data?.trackUrl || 'https://alluvi.org/track-order';
      const supportTeam = data?.supportTeam || 'Alluvi Support Team';

      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>
            <p style="margin: 14px 0 0 0; color: rgba(255,255,255,0.92); font-size: 14px;">Order Update & Tracking</p>
          </div>

          <div style="padding: 50px 40px;">
            <h2 style="font-size: 26px; font-weight: 750; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Important information about your order</h2>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Dear ${customerInfoName || 'Customer'},</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">We are currently processing orders for customers on our waiting list and are working diligently to full fill them in first come first serve.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">In the meantime, you may track the status of your order using our newly launched tracking feature, you can also pay on it after you have got your email for added reassurance from the official www.alluvi.org website:</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">Track your order</div>
              <div style="font-size: 15px; color: #1a1a1a; line-height: 1.7; word-break: break-word;">${trackUrl}</div>
            </div>

            <div style="text-align: center; margin: 26px 0;">
              <a href="${trackUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 700; font-size: 16px;">Open Tracking Page</a>
            </div>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">To access your order information, simply enter your email address on the tracking page. A One-Time Passcode (OTP) will be sent to your email, allowing you to view the status of all orders associated with that email address.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Payment request links will be issued in batches over the next 24-48 hours, starting today. As these are sent out in order, not all Remember customers will receive them at the same time. We kindly ask for your patience while we complete this process.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">We will continue sending payment request emails until all waiting list orders have been fully addressed.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">Need help?</div>
              <div style="font-size: 15px; color: #1a1a1a; line-height: 1.7;">We have introduced a live chat feature on our website to assist you with any questions or concerns regarding your order. Our team is here to support you.</div>
            </div>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 26px 0 0 0;">Thank you for your patience and understanding.</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 18px 0 0 0;">Warm regards,<br><strong style="color: #1a1a1a;">${supportTeam}</strong></p>
          </div>

          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For any questions, please contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;

    case 'has_invoice':
      content = '';
      break;

    case 'tracking_otp':
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="margin: 14px 0 0 0; color: rgba(255,255,255,0.92); font-size: 14px;">Track Order Verification</p>
          </div>
          <div style="padding: 46px 40px;">
            <h2 style="font-size: 22px; font-weight: 700; color: #1c1c1c; margin: 0 0 14px 0; line-height: 1.3;">Your one-time code</h2>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Use this code to access your order details:</p>

            <div style="font-size: 34px; font-weight: 900; letter-spacing: 6px; text-align: center; background: #f6f6f6; border: 1px solid #e9e9e9; padding: 18px 12px; border-radius: 12px; color: #111;">
              ${String(data?.otp || '').trim()}
            </div>
            <p style="margin: 18px 0 0 0; font-size: 13px; color: #666; line-height: 1.7;">This code expires in ${Number(data?.expiresMinutes || 10)} minutes.</p>
            <p style="margin: 10px 0 0 0; font-size: 13px; color: #666; line-height: 1.7;">If you did not request this, you can ignore this email.</p>
          </div>
          <div style="padding: 20px 40px 30px; text-align: center; color: #888; font-size: 12px;">
            &copy; ${new Date().getFullYear()} Alluvi
          </div>
        </div>
      `;
      break;

    case 'payment_capture':
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Payment Required</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;"><strong>Complete Your Payment.</strong></h2>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Hi ${String(data?.customerName || '').trim() || 'there'},</p>

            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">You recently placed an order request on Alluvi. No payment was taken at that time.</p>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">This email contains your secure link to pay for that order.</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 10px 0;">If you complete payment before 2 pm (Mon to Fri), your order will ship the same day for next day delivery.</p>
            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Payments made after 2 pm will ship the next working day.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              <div style="margin-bottom: 12px;">
                <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                <div style="font-size: 18px; font-weight: 800; color: #1a1a1a;">${String(data?.orderNumber || '').trim()}</div>
              </div>
              <div style="margin-bottom: 12px;">
                <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Amount</div>
                <div style="font-size: 20px; font-weight: 800; color: #FF8200;">£${Number(data?.total || 0).toFixed(2)} ${String(data?.currency || 'GBP').trim() || 'GBP'}</div>
              </div>
            </div>

            <div style="text-align: center; margin: 26px 0;">
              <a href="${String(data?.paymentLink || '').trim()}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 700; font-size: 16px;">Open Secure Payment Page</a>
            </div>

            <h3 style="font-size: 18px; font-weight: 800; color: #1a1a1a; margin: 10px 0 12px 0;"><strong>How to complete your payment</strong></h3>

            <div style="font-size: 15px; line-height: 1.8; color: #4a4a4a; margin: 0 0 18px 0;">
              <div style="margin: 0 0 8px 0;">Click the secure payment link/Button.</div>
              <div style="margin: 0 0 8px 0;">Follow the instructions on the page to send your payment.</div>
              <div style="margin: 0 0 8px 0;">Upload your payment screenshot when asked.</div>
              <div style="margin: 0;">Once we confirm your payment, you will receive another email and your order will move to shipping.</div>
            </div>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              <div style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 12px 0;">
                If you need help, you can message us on Live Chat on the official website <strong>www.alluvi.org</strong>,
                <br/>or use the button below to contact us via Live Chat.
              </div>
              <div style="text-align: center; margin: 0;">
                <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Alluvi Support</a>
              </div>
            </div>

            <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0;">If you did not place this order, you can safely ignore this email.</p>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
          </div>
        </div>
      `;
      break;

    case 'payment_successful':
      const paymentPublicBase = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || 'https://www.alluvi.org').replace(/\/$/, '');
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Payment Successful</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 700; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Your order will now be prepared for shipping!</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Hi ${String(data?.customerName || '').trim() || 'there'},</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 10px 0;">We have successfully verified your payment. Your order will now be prepared for shipping.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 18px 0 18px 0; border-radius: 8px;">
              <div style="font-size: 14px; line-height: 1.7; color: #4a4a4a; margin: 0;">
                Orders are typically processed within 2 working days. Once your order is dispatched, you will receive a separate email with your tracking details. Please keep an eye on your inbox (and spam/junk folder) for updates.
              </div>
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">You will receive another email once your order has been shipped with your tracking number.</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 22px 0;">You can also check the progress of your order by logging in and going to the Track Orders page. Your tracking number will appear there once the parcel has been shipped.</p>

            <div style="text-align: center; margin: 26px 0 0; display: flex; flex-direction: column; gap: 12px; align-items: center;">
              <a href="${paymentPublicBase}/track-order" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Track your order</a>
              <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Alluvi Support</a>
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For help, contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;

    case 'payment_screenshot_received':
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Payment Screenshot Received</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Thank you for your submission</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Hi ${safeText(data?.customerName, 'there')},</p>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 14px 0;">Thank you for uploading your payment screenshot.</p>
            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 14px 0;">Our team will now review your submission and verify your payment manually. Once verification is complete, we will email you with an update on your payment status.</p>
            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 18px 0;">Please keep an eye on your inbox (and your spam/junk folder, just in case).</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 22px; margin: 22px 0; border-radius: 8px;">
              ${safeText(data?.orderNumber, '') ? `
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                  <div style="font-size: 18px; font-weight: 900; color: #1a1a1a;">${safeText(data?.orderNumber, '')}</div>
                </div>
              ` : ''}
              ${safeText(data?.amountText, '') ? `
                <div>
                  <div style="font-size: 12px; font-weight: 700; color: #666; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Amount</div>
                  <div style="font-size: 18px; font-weight: 900; color: #1a1a1a;">${safeText(data?.amountText, '')}</div>
                </div>
              ` : ''}
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Thank you for your patience and cooperation, and thank you for shopping with Alluvi.</p>

            <div style="text-align: center; margin: 22px 0 0;">
              <a href="https://alluvi.org/track-order?openChat=1" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Contact Alluvi Support</a>
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For help, contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;

    case 'payment_declined':
      content = `
        <div style="background: #f3f3f3; padding: 24px 14px;">
          <div style="max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 6px 22px rgba(0,0,0,0.10); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <div style="background: #FF8200; padding: 44px 40px; text-align: center;">
              ${headerLogoHtml}
              <p style="font-size: 12px; font-style: italic; color: rgba(255,255,255,0.92); margin: 10px 0 0 0;">Payment Declined</p>
            </div>
            <div style="padding: 42px 40px 30px 40px;">
              <h2 style="font-size: 28px; font-weight: 900; color: #111; margin: 0 0 16px 0; line-height: 1.2;">We couldn’t verify your payment</h2>
              <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0 0 12px 0;">Hi ${String(data?.customerName || '').trim() || 'there'},</p>

              <p style="font-size: 13px; line-height: 1.7; color: #666; margin: 0 0 16px 0;">Our automated verification couldn’t confirm your payment. Please upload a clearer payment screenshot and try again.</p>

              <div style="background: #fafafa; border-left: 4px solid #ef4444; padding: 18px 18px; margin: 18px 0; border-radius: 8px;">
                ${data?.orderNumber ? `
                  <div style="margin-bottom: 10px;">
                    <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                    <div style="font-size: 14px; font-weight: 900; color: #111;">${data.orderNumber}</div>
                  </div>
                ` : ''}
                ${data?.reason ? `
                  <div>
                    <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Details</div>
                    <div style="font-size: 13px; color: #111; line-height: 1.7;">${data.reason}</div>
                  </div>
                ` : ''}
              </div>

              ${data?.retryLink ? `
                <div style="text-align: center; margin: 18px 0 22px;">
                  <a href="${data.retryLink}" style="display: inline-block; background: #FF8200; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 900; font-size: 13px;">Try Payment Again</a>
                </div>
              ` : ''}

              <p style="font-size: 12px; line-height: 1.7; color: #777; margin: 0;">If you did not place this order, you can safely ignore this email.</p>
            </div>
            <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 34px 24px; text-align: center;">
              <p style="font-size: 11px; color: #aaa; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
              <p style="font-size: 11px; color: #aaa; margin: 8px 0;">For help, contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none; font-weight: 800;">Alluvi usa</a>.</p>
            </div>
          </div>
        </div>
      `;
      break;

    case 'status_update':
      const statusClass = data.status.toLowerCase().replace(' ', '-');
      const statusColors = {
        'pending': '#fff3cd',
        'processing': '#d1ecf1', 
        'shipped': '#cce5ff',
        'delivered': '#d4edda',
        'cancelled': '#f8d7da'
      };
      const statusBg = statusColors[statusClass] || '#f8f9fa';
      
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <h1 style="font-size: 36px; font-weight: 800; color: #ffffff; margin: 0; letter-spacing: -1px;">ALLUVI</h1>
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Premium Research Peptides</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 700; color: #1a1a1a; margin: 0 0 25px 0; line-height: 1.3;">Order Status Update</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 25px 0;">Hi ${data.customerName},</p>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 25px 0;">Your order status has been updated.</p>
            
            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 25px; margin: 25px 0; border-radius: 8px;">
              <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
              <div style="font-size: 20px; font-weight: 700; color: #1a1a1a; margin: 0;">${data.orderNumber}</div>
            </div>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 25px; margin: 25px 0; border-radius: 8px;">
              <div style="font-size: 12px; font-weight: 600; color: #666; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 1px;">New Status</div>
              <div><span style="display: inline-block; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; background: ${statusBg}; color: #1a1a1a;">${data.status}</span></div>
            </div>

            ${data.message ? `<p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 25px 0;">${data.message}</p>` : ''}
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> 2024 Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">For any questions, please contact us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;

    case 'out_for_delivery': {
      const tn = String(data?.trackingNumber || '').trim();
      const trackUrl = tn ? `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(tn)}` : '';
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="margin: 14px 0 0 0; color: rgba(255,255,255,0.92); font-size: 14px;">Delivery Update</p>
          </div>
          <div style="padding: 46px 40px;">
            <h2 style="margin: 0 0 14px 0; font-size: 22px; color: #1c1c1c;">Your order is out for delivery</h2>
            <p style="margin: 0 0 18px 0; font-size: 14px; color: #444; line-height: 1.7;">Hi ${String(data?.customerName || '').trim() || 'there'},</p>
            <p style="margin: 0 0 18px 0; font-size: 14px; color: #444; line-height: 1.7;">Great news! Your order should arrive soon.</p>

            <div style="margin: 18px 0; background: #f6f6f6; border: 1px solid #e9e9e9; padding: 16px 14px; border-radius: 12px; color: #111;">
              <div style="font-size: 12px; color: #666; margin-bottom: 6px;">Order number</div>
              <div style="font-size: 18px; font-weight: 800; letter-spacing: 0.5px;">${String(data?.orderNumber || '').trim()}</div>
            </div>

            <div style="margin: 18px 0; background: #f6f6f6; border: 1px solid #e9e9e9; padding: 16px 14px; border-radius: 12px; color: #111;">
              <div style="font-size: 12px; color: #666; margin-bottom: 6px;">Tracking number</div>
              <div style="font-size: 18px; font-weight: 900; letter-spacing: 1px;">${String(data?.trackingNumber || '').trim()}</div>
              <p style="margin: 10px 0 0 0; font-size: 13px; color: #666; line-height: 1.7;">Use this number to track your package.</p>
            </div>

            ${trackUrl ? `
              <div style="text-align: center; margin: 18px 0 0 0;">
                <a href="${trackUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 700; font-size: 16px;">Track Now</a>
              </div>
            ` : ''}

            <div style="margin: 18px 0 0 0; background: #f6f6f6; border: 1px solid #e9e9e9; padding: 16px 14px; border-radius: 12px; color: #111;">
              <div style="font-size: 12px; color: #666; margin-bottom: 6px;">Delivery address</div>
              <div style="font-size: 14px; color: #111; line-height: 1.8;">
                ${String(data?.shippingAddress || '').trim()}<br>
                ${String(data?.shippingCity || '').trim()}${String(data?.shippingState || '').trim() ? ', ' + String(data?.shippingState || '').trim() : ''} ${String(data?.shippingZip || '').trim()}<br>
                ${String(data?.shippingCountry || '').trim()}
              </div>
            </div>

          </div>
          <div style="padding: 20px 40px 30px; text-align: center; color: #888; font-size: 12px;">
            &copy; ${new Date().getFullYear()} Alluvi
          </div>
        </div>
      `;
      break;
    }

    case 'order_delivered':
      content = `
        <div class="email-container">
          ${baseStyle}
          <div class="email-header">
            <h1 class="email-logo">ALLUVI</h1>
          </div>
          <div class="email-body">
            <h2 class="email-title">Your Order Has Been Delivered! </h2>
            <p class="email-text">Hi ${data.customerName},</p>
            <p class="email-text">Your order has been successfully delivered. We hope you enjoy your purchase!</p>
            
            <div class="email-box">
              <div class="email-box-title">Order Number</div>
              <div class="email-box-value">${data.orderNumber}</div>
            </div>

            <p class="email-text" style="margin-top: 30px;">If you have any questions or concerns about your order, please don't hesitate to contact us.</p>
            
            <p class="email-text">Thank you for shopping with Alluvi!</p>
          </div>
          <div class="email-footer">
            <p class="email-footer-text"> 2024 Alluvi. All rights reserved.</p>
            <p class="email-footer-text">Need help? Contact us at support@alluvi.com</p>
          </div>
        </div>
      `;
      break;

    case 'order_cancelled':
      content = `
        <div class="email-container">
          ${baseStyle}
          <div class="email-header">
            <h1 class="email-logo">ALLUVI</h1>
          </div>
          <div class="email-body">
            <h2 class="email-title">Order Cancelled</h2>
            <p class="email-text">Hi ${data.customerName},</p>
            <p class="email-text">Your order has been cancelled as requested.</p>
            
            <div class="email-box">
              <div class="email-box-title">Order Number</div>
              <div class="email-box-value">${data.orderNumber}</div>
            </div>

            <p class="email-text" style="margin-top: 20px;">If you didn't request this cancellation or have any questions, please contact us immediately.</p>
          </div>
          <div class="email-footer">
            <p class="email-footer-text"> 2024 Alluvi. All rights reserved.</p>
            <p class="email-footer-text">Need help? Contact us at support@alluvi.com</p>
          </div>
        </div>
      `;
      break;

    case 'refund_initiated': {
      const name = String(data?.customerName || '').trim() || 'there';
      const orderNumber = String(data?.orderNumber || '').trim();
      const amount = Number(data?.amount || data?.total || 0);
      const currency = String(data?.currency || 'GBP').trim() || 'GBP';
      const trackUrl = String(data?.trackUrl || 'https://www.alluvi.org/track-order').trim();

      content = `
        <div style="background: #f3f3f3; padding: 24px 14px;">
          <div style="max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 6px 22px rgba(0,0,0,0.10); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <div style="background: #FF8200; padding: 44px 40px; text-align: center;">
              ${headerLogoHtml}
              <p style="font-size: 12px; font-style: italic; color: rgba(255,255,255,0.92); margin: 10px 0 0 0;">Refund Initiated</p>
            </div>
            <div style="padding: 42px 40px 30px 40px;">
              <h2 style="font-size: 28px; font-weight: 900; color: #111; margin: 0 0 16px 0; line-height: 1.2;">Your refund has been initiated</h2>
              <p style="font-size: 14px; line-height: 1.7; color: #666; margin: 0 0 12px 0;">Hi ${name},</p>

              <p style="font-size: 13px; line-height: 1.7; color: #666; margin: 0 0 16px 0;">We have initiated a refund for your order. The refunded amount will be returned to the same payment method you used for the purchase. Depending on your bank, it may take a few business days to appear on your statement.</p>

              <div style="background: #fafafa; border-left: 4px solid #ef4444; padding: 18px 18px; margin: 18px 0; border-radius: 8px;">
                ${orderNumber ? `
                  <div style="margin-bottom: 10px;">
                    <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>
                    <div style="font-size: 14px; font-weight: 900; color: #111;">${orderNumber}</div>
                  </div>
                ` : ''}
                <div>
                  <div style="font-size: 10px; font-weight: 800; color: #777; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 1px;">Refund Amount</div>
                  <div style="font-size: 14px; font-weight: 900; color: #ef4444;">£${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'} ${currency}</div>
                </div>
              </div>

              <div style="text-align: center; margin: 18px 0 0;">
                <a href="${trackUrl}" style="display: inline-block; background: #FF8200; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 900; font-size: 13px;">Open Track Order</a>
              </div>
            </div>
            <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 34px 24px; text-align: center;">
              <p style="font-size: 11px; color: #aaa; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case 'affiliate_welcome': {
      const firstName = safeText(data?.firstName, '').trim() || 'there';
      const promoCode = safeText(data?.promoCode, '').trim().toUpperCase();
      const percent = Number.isFinite(Number(data?.percent)) ? Number(data.percent) : 10;
      const rewardAmount = Number.isFinite(Number(data?.rewardAmount)) ? Number(data.rewardAmount) : 40;
      const welcomePublicBase = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || 'https://www.alluvi.org').replace(/\/$/, '');
      const dashboardUrl = `${welcomePublicBase}/track-order`;
      const tiktokShareUrl = `https://www.tiktok.com/upload?lang=en`;
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Welcome to the Alluvi Affiliate Program</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">You're in, ${firstName}.</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Your affiliate code is live. Every time someone uses it at checkout, they save ${percent}% and you earn £${rewardAmount.toFixed(2)} in Alluvi credit per unique paying customer.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 24px; margin: 22px 0; border-radius: 8px; text-align: center;">
              <div style="font-size: 13px; color: #666; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Your promo code</div>
              <div style="font-size: 32px; font-weight: 800; color: #FF8200; letter-spacing: 2px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;">${promoCode}</div>
              <div style="font-size: 13px; color: #666; margin-top: 12px;">${percent}% off for buyers · £${rewardAmount.toFixed(2)} credit for you</div>
            </div>

            <h3 style="font-size: 18px; font-weight: 700; color: #1a1a1a; margin: 30px 0 12px 0;">How to share on TikTok</h3>
            <div style="background: #fff8f0; border: 1px solid #ffe0bf; padding: 20px; margin: 0 0 22px 0; border-radius: 8px;">
              <p style="font-size: 14px; line-height: 1.7; color: #4a4a4a; margin: 0 0 10px 0;">Drop your code in your bio, captions, or pinned comments. A simple opener that works:</p>
              <div style="background: #ffffff; border: 1px dashed #ffb573; padding: 14px; border-radius: 6px; font-style: italic; color: #1a1a1a; font-size: 14px; line-height: 1.6;">"Use code <strong>${promoCode}</strong> at Alluvi usa for ${percent}% off your first order."</div>
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 22px 0;">Track your redemptions and credit balance from your Track Orders page anytime.</p>

            <div style="text-align: center; margin: 26px 0 0; display: flex; flex-direction: column; gap: 12px; align-items: center;">
              <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Open your dashboard</a>
              <a href="${tiktokShareUrl}" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 10px; font-weight: 800; font-size: 14px;">Post on TikTok</a>
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">Questions? Reach us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'affiliate_redemption': {
      const firstName = safeText(data?.firstName, '').trim() || 'there';
      const promoCode = safeText(data?.promoCode, '').trim().toUpperCase();
      const rewardAmount = Number.isFinite(Number(data?.rewardAmount)) ? Number(data.rewardAmount) : 40;
      const newBalance = Number.isFinite(Number(data?.newBalance)) ? Number(data.newBalance) : null;
      const redemptionPublicBase = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || 'https://www.alluvi.org').replace(/\/$/, '');
      const dashboardUrl = `${redemptionPublicBase}/track-order`;
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">Promo Code Redeemed</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">You just earned £${rewardAmount.toFixed(2)}, ${firstName}.</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Someone used your affiliate code <strong>${promoCode}</strong> at checkout and their order has been paid. £${rewardAmount.toFixed(2)} in Alluvi credit has been added to your balance.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #00d4aa; padding: 24px; margin: 22px 0; border-radius: 8px;">
              <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
                <div>
                  <div style="font-size: 13px; color: #666; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px;">Reward earned</div>
                  <div style="font-size: 22px; font-weight: 800; color: #00b894;">+ £${rewardAmount.toFixed(2)}</div>
                </div>
                ${newBalance !== null ? `
                <div style="text-align: right;">
                  <div style="font-size: 13px; color: #666; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px;">New balance</div>
                  <div style="font-size: 22px; font-weight: 800; color: #1a1a1a;">£${newBalance.toFixed(2)}</div>
                </div>
                ` : ''}
              </div>
            </div>

            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 22px 0;">Keep sharing your code — every unique paying customer adds another £${rewardAmount.toFixed(2)} to your balance.</p>

            <div style="text-align: center; margin: 26px 0 0;">
              <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">View dashboard</a>
            </div>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">Questions? Reach us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;
    }

    case 'newsletter_entry': {
      const productName = safeText(data?.productName, 'Retatrutide 40mg pen');
      const firstName = safeText(data?.firstName, '').trim() || 'there';
      // Personal, transactional-feel email — minimal chrome to bias toward Primary inbox tab
      content = `
        <div style="max-width: 560px; margin: 0 auto; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; padding: 36px 28px; color: #1a1a1a;">
          <p style="font-size: 16px; line-height: 1.7; color: #1a1a1a; margin: 0 0 16px 0;">Hi ${firstName},</p>

          <p style="font-size: 16px; line-height: 1.7; color: #1a1a1a; margin: 0 0 14px 0;">Thanks for entering — we've got you down for this month's draw. The prize is a free <strong>${productName}</strong>, and we'll pick the winner at the end of the month.</p>

          <p style="font-size: 16px; line-height: 1.7; color: #1a1a1a; margin: 0 0 14px 0;">If your email is the one drawn, you'll hear from me directly at this address. Nothing else for you to do right now.</p>

          <p style="font-size: 16px; line-height: 1.7; color: #1a1a1a; margin: 0 0 20px 0;">Good luck.</p>

          <p style="font-size: 16px; line-height: 1.7; color: #1a1a1a; margin: 0 0 4px 0;">— The Alluvi team</p>
          <p style="font-size: 13px; line-height: 1.6; color: #888; margin: 0 0 28px 0;"><a href="https://alluvi.org" style="color: #888; text-decoration: underline;">Alluvi usa</a></p>

          <hr style="border: none; border-top: 1px solid #eaeaea; margin: 24px 0;" />

          <p style="font-size: 11px; line-height: 1.55; color: #999; margin: 0;">You're receiving this because you entered the Alluvi giveaway at Alluvi usa. Alluvi products are supplied for in vitro R&amp;D only — not for human or veterinary use. To opt out, reply with "unsubscribe".</p>
        </div>
      `;
      break;
    }

    case 'newsletter_winner': {
      const claimUrl = safeText(data?.claimUrl, '').trim() || `mailto:info@alluvi.org?subject=Giveaway%20winner%20-%20claim%20my%20prize`;
      const productName = safeText(data?.productName, 'Retatrutide 40mg pen');
      const claimDeadline = safeText(data?.claimDeadline, '14 days');
      const firstName = safeText(data?.firstName, '').trim() || 'there';
      content = `
        <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <div style="background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); padding: 50px 40px; text-align: center;">
            <div style="font-size: 22px; line-height: 1; letter-spacing: 6px; margin: 0 0 10px 0;" aria-hidden="true">🎉&nbsp;&nbsp;✨&nbsp;&nbsp;🎊&nbsp;&nbsp;✨&nbsp;&nbsp;🎉</div>
            <div style="font-size: 64px; line-height: 1; margin: 0 0 14px 0;" aria-hidden="true">🏆</div>
            ${headerLogoHtml}
            <p style="font-size: 14px; color: rgba(255,255,255,0.95); margin: 10px 0 0 0; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;">You won!</p>
          </div>
          <div style="padding: 50px 40px;">
            <h2 style="font-size: 28px; font-weight: 800; color: #1a1a1a; margin: 0 0 18px 0; line-height: 1.3;">Congratulations, ${firstName} — you've won!</h2>
            <p style="font-size: 16px; line-height: 1.7; color: #4a4a4a; margin: 0 0 16px 0;">Brilliant news. Your email was drawn for this month's Alluvi giveaway. The prize is yours: a free <strong>${productName}</strong>, on us.</p>

            <div style="background: #f8f9fa; border-left: 4px solid #FF8200; padding: 24px; margin: 22px 0; border-radius: 8px; text-align: center;">
              <div style="font-size: 13px; color: #666; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Your prize</div>
              <div style="font-size: 24px; font-weight: 800; color: #FF8200; letter-spacing: 0.5px;">${productName}</div>
              <div style="font-size: 13px; color: #666; margin-top: 12px;">For in vitro research use only · Janoshik-tested · Cold-chain shipping</div>
            </div>

            <h3 style="font-size: 18px; font-weight: 700; color: #1a1a1a; margin: 30px 0 12px 0;">How to claim</h3>
            <p style="font-size: 15px; line-height: 1.7; color: #4a4a4a; margin: 0 0 14px 0;">Click below within <strong>${claimDeadline}</strong> and reply to this email with your delivery details. We'll dispatch your prize the next working day. After ${claimDeadline}, the prize rolls over to next month's draw.</p>

            <div style="text-align: center; margin: 26px 0 0;">
              <a href="${claimUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF8200 0%, #E67700 100%); color: #ffffff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: 800; font-size: 16px;">Claim your prize</a>
            </div>

            <p style="font-size: 12px; line-height: 1.6; color: #999; margin: 30px 0 0 0; text-align: center;">If you have any trouble, reply directly to this email and we'll sort it out. Alluvi products are supplied for in vitro R&amp;D only.</p>
          </div>
          <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); color: #ffffff; padding: 40px; text-align: center;">
            <p style="font-size: 14px; color: #999; margin: 8px 0;"> ${new Date().getFullYear()} Alluvi. All rights reserved.</p>
            <p style="font-size: 14px; color: #999; margin: 8px 0;">Questions? Reach us via Live Chat on <a href="https://alluvi.org" style="color: #FF8200; text-decoration: none;">Alluvi usa</a>.</p>
          </div>
        </div>
      `;
      break;
    }

    default:
      content = `<p>Order update notification</p>`;
  }

  try {
    const hasShell = /background:\s*#f3f3f3/i.test(content);
    if (!hasShell) {
      content = `<div style="background: #f3f3f3; padding: 24px 14px;">${content}</div>`;
    }

    content = content
      .replace(/background:\s*linear-gradient\(135deg,\s*#FF8200\s*0%,\s*#E67700\s*100%\)/gi, 'background: #FF8200')
      .replace(/background:\s*linear-gradient\(135deg,\s*#ff8200\s*0%,\s*#e67700\s*100%\)/gi, 'background: #FF8200');
  } catch {
    // ignore
  }

  return content;
};

// Send email function
export const sendEmail = async (to, subject, type, data, opts = {}) => {
  try {
    const toRaw = String(to || '').trim();
    const toLower = toRaw.toLowerCase();
    if (toLower.includes('@ivmsgroup.com')) {
      console.warn('[emailService] blocked recipient domain ivmsgroup.com', { to: toRaw, subject, type });
      return { success: false, skipped: true, error: 'Recipient domain blocked', to: toRaw };
    }

    const normalizedType = String(type || '').trim();
    const normalizedSubject = String(subject || '').trim();
    if (
      normalizedType === 'payment_declined' &&
      (!normalizedSubject || /^payment\s+declined\b/i.test(normalizedSubject))
    ) {
      subject = 'Payment cannot be verified';
    }

    console.log('Attempting to send email:', { to, subject, type });
    console.log('Email user:', process.env.EMAIL_USER);
    console.log('Email pass configured:', !!process.env.EMAIL_PASS);

    let htmlContent = getEmailTemplate(type, data);
    const mailjetApiKey = env('MAILJET_API_KEY');
    const mailjetSecretKey = env('MAILJET_SECRET_KEY');
    const mailjetFrom = env('MAILJET_SENDER_EMAIL');
    const resendApiKey = env('RESEND_API_KEY');

    console.log('Mailjet configured:', {
      hasApiKey: !!mailjetApiKey,
      hasSecretKey: !!mailjetSecretKey,
      hasFrom: !!mailjetFrom,
    });

    const nodemailerAttachments = Array.isArray(opts?.attachments) ? opts.attachments : [];
    const mailjetInlineAttachments = Array.isArray(opts?.mailjetInlineAttachments) ? opts.mailjetInlineAttachments : [];
    const headers = (opts && typeof opts === 'object' && opts.headers && typeof opts.headers === 'object') ? opts.headers : {};
    const plainText = (opts && typeof opts.text === 'string' && opts.text.trim()) ? opts.text : '';

    if (resendApiKey) {
      console.log('Email provider selected: resend');

      try {
        const publicBase = String(env('PUBLIC_BASE_URL', env('PUBLIC_API_BASE_URL', env('FRONTEND_URL', 'https://alluvi.org')))).replace(/\/$/, '');
        const logoUrl = `${publicBase}/images/Alluvi-logo-2-white.png`;
        htmlContent = String(htmlContent || '').replaceAll(`cid:${ALLUVI_LOGO_CID}`, logoUrl);
      } catch {}

      const r = await sendEmailViaResend({ to, subject, html: htmlContent, text: plainText, headers });
      if (!r?.success) {
        console.error(' Resend send failed:', r?.error, r?.details ? { details: r.details } : '');
        return { success: false, error: r?.error || 'Resend send failed' };
      }
      console.log(' Email sent successfully:', r.messageId);
      return { success: true, messageId: r.messageId };
    }

    if (mailjetApiKey && mailjetSecretKey && mailjetFrom) {
      console.log('Email provider selected: mailjet');
      const r = await sendEmailViaMailjet({ to, subject, html: htmlContent, text: plainText, inlineAttachments: mailjetInlineAttachments, headers });
      if (!r?.success) {
        console.error(' Mailjet send failed:', r?.error, r?.details ? { details: r.details } : '');
        return { success: false, error: r?.error || 'Mailjet send failed' };
      }
      console.log(' Email sent successfully:', r.messageId);
      return { success: true, messageId: r.messageId };
    }

    console.log('Email provider selected: nodemailer');

    const transporter = createTransporter();

    const nodemailerFromNameRaw = env('EMAIL_FROM_NAME', 'Team Alluvi');
    const nodemailerFromName = /klyme/i.test(nodemailerFromNameRaw) ? 'Alluvi' : nodemailerFromNameRaw;
    const nodemailerFromEmail = env('EMAIL_FROM_EMAIL', process.env.EMAIL_USER || 'info@alluvi.org');

    const mailOptions = {
      from: `${nodemailerFromName} <${nodemailerFromEmail}>`,
      to: to,
      subject: subject,
      html: htmlContent,
      ...(plainText ? { text: plainText } : {}),
      ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {}),
      ...(nodemailerAttachments.length ? { attachments: nodemailerAttachments } : {})
    };

    console.log('Sending mail with options (subject only):', { subject: mailOptions.subject, to: mailOptions.to });
    
    // Add timeout wrapper
    const sendWithTimeout = Promise.race([
      transporter.sendMail(mailOptions),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Email sending timeout after 15 seconds')), 15000)
      )
    ]);
    
    const info = await sendWithTimeout;
    console.log('✅ Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending email:', error);
    console.error('Email error details:', error.message);
    console.error('Email error stack:', error.stack);
    return { success: false, error: error.message };
  }
};

// Send order confirmation email
export const sendOrderConfirmationEmail = async (orderData) => {
  return await sendEmail(
    orderData.customerEmail,
    `Order Confirmation - ${orderData.orderNumber}`,
    'order_confirmation',
    orderData
  );
};

// Send status update email
export const sendStatusUpdateEmail = async (orderData, newStatus, message = '') => {
  const statusMessages = {
    'paid': 'Your payment has been confirmed and your order is being processed.',
    'processing': 'Your order is being prepared for shipment.',
    'shipped': 'Your order has been shipped and is on its way to you.',
    'delivered': 'Your order has been delivered successfully.',
    'cancelled': 'Your order has been cancelled.',
    'refunded': 'Your order has been refunded.'
  };

  return await sendEmail(
    orderData.customerEmail,
    `Order Status Update - ${orderData.orderNumber}`,
    'status_update',
    {
      ...orderData,
      status: newStatus,
      message: message || statusMessages[newStatus.toLowerCase()] || ''
    }
  );
};

// Send out for delivery email with tracking
export const sendOutForDeliveryEmail = async (orderData, trackingNumber) => {
  return await sendEmail(
    orderData.customerEmail,
    `Your Order is Out for Delivery - ${orderData.orderNumber}`,
    'out_for_delivery',
    {
      ...orderData,
      trackingNumber
    }
  );
};

// Send delivered email
export const sendDeliveredEmail = async (orderData) => {
  return await sendEmail(
    orderData.customerEmail,
    `Your Order Has Been Delivered - ${orderData.orderNumber}`,
    'order_delivered',
    orderData
  );
};

// Send cancelled email
export const sendCancelledEmail = async (orderData) => {
  return await sendEmail(
    orderData.customerEmail,
    `Order Cancelled - ${orderData.orderNumber}`,
    'order_cancelled',
    orderData
  );
};

export const sendPaymentSuccessfulEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Payment Successful - ${data.orderNumber}` : 'Payment Successful');
  return await sendEmail(
    to,
    subject,
    'payment_successful',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendKlymePaymentSuccessfulEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Payment Successful - ${data.orderNumber}` : 'Payment Successful');
  return await sendEmail(
    to,
    subject,
    'klyme_payment_successful',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendPaymentDeclinedEmail = async (to, data = {}) => {
  const subject = data?.subject || 'Payment cannot be verified';
  return await sendEmail(
    to,
    subject,
    'payment_declined',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendPaymentScreenshotReceivedEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Payment Screenshot Received - ${data.orderNumber}` : 'Payment Screenshot Received');
  return await sendEmail(
    to,
    subject,
    'payment_screenshot_received',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendDeliveryInformationEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Delivery Information - ${data.orderNumber}` : 'Delivery Information');
  return await sendEmail(
    to,
    subject,
    'delivery_information',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendKlymePaymentRejectedEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Payment Rejected - ${data.orderNumber}` : 'Payment Rejected');
  return await sendEmail(
    to,
    subject,
    'klyme_payment_rejected',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendRefundInitiatedEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Refund Initiated - ${data.orderNumber}` : 'Refund Initiated');
  return await sendEmail(
    to,
    subject,
    'refund_initiated',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendPaymentReminderEmail = async (to, data = {}) => {
  const subject = data?.subject || (data?.orderNumber ? `Payment Reminder - ${data.orderNumber}` : 'Payment Reminder');
  return await sendEmail(
    to,
    subject,
    'payment_reminder',
    data,
    {
      headers: {
        'List-Unsubscribe': data?.unsubscribeUrl ? `<${String(data.unsubscribeUrl).trim()}>` : undefined,
        'List-Unsubscribe-Post': data?.unsubscribeUrl ? 'List-Unsubscribe=One-Click' : undefined,
      },
    }
  );
};

export const sendHasInvoiceEmail = async (to, invoiceData = {}) => {
  return {
    success: false,
    skipped: true,
    error: 'HAS invoice email disabled',
    to,
  };
};

export const sendIbalticxEmail = async (to, invoiceData = {}) => {
  const baseUrl = String(env('PUBLIC_BASE_URL', env('PUBLIC_API_BASE_URL', 'https://alluvi.org'))).replace(/\/$/, '');
  const explicitLogoUrl = String(invoiceData?.logoUrl || '').trim();
  const payload = {
    ...invoiceData,
    ...(!explicitLogoUrl && invoiceData?.logoUrl === undefined ? { logoUrl: `${baseUrl}/images/Alluvi-logo-2-white.png` } : {}),
  };

  return await sendEmail(
    to,
    invoiceData?.subject || `Invoice - ${invoiceData?.invoiceNumber || 'INV-1092'}`,
    'ibalticx',
    payload
  );
};

export const sendCustomerInfoEmail = async (to, data = {}) => {
  return await sendEmail(
    to,
    data?.subject || 'Order Update & Tracking Information',
    'customer_info',
    data
  );
};

export const sendAffiliateWelcomeEmail = async (to, data = {}) => {
  const subject = data?.subject || 'Welcome to the Alluvi Affiliate Program';
  return await sendEmail(
    to,
    subject,
    'affiliate_welcome',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

export const sendAffiliateRewardNotificationEmail = async (to, data = {}) => {
  const subject = data?.subject || 'Your affiliate code was just used';
  return await sendEmail(
    to,
    subject,
    'affiliate_redemption',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
      };
    })()
  );
};

// Plain-language subjects + List-Unsubscribe + plain-text alternative all push these
// emails toward the Primary tab in Gmail. Without a plain-text part, the message
// looks like marketing-only HTML and is very likely to land in Promotions.
const NEWSLETTER_UNSUBSCRIBE_MAILTO = `mailto:${env('EMAIL_FROM_EMAIL', 'info@alluvi.org')}?subject=Unsubscribe`;

export const sendNewsletterEntryEmail = async (to, data = {}) => {
  const productName = (data?.productName && String(data.productName).trim()) || 'Retatrutide 40mg pen';
  // Conversational subject avoids classic promo triggers ("free", "giveaway", "win")
  const subject = data?.subject || `Got your giveaway entry`;

  const text = [
    `Hi,`,
    ``,
    `Thanks for entering — we've got you down for this month's draw.`,
    `The prize is a free ${productName}, picked at the end of the month.`,
    ``,
    `If your email is the one drawn, you'll hear from me directly at this`,
    `address. Nothing else for you to do right now.`,
    ``,
    `Good luck.`,
    ``,
    `— The Alluvi team`,
    `https://alluvi.org`,
    ``,
    `--`,
    `You're receiving this because you entered the Alluvi giveaway at Alluvi usa.`,
    `To opt out, reply with "unsubscribe".`,
    `Alluvi products are for in vitro R&D only.`,
  ].join('\n');

  return await sendEmail(
    to,
    subject,
    'newsletter_entry',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
        text,
        headers: {
          'List-Unsubscribe': `<${NEWSLETTER_UNSUBSCRIBE_MAILTO}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Entity-Ref-ID': `newsletter-entry-${Date.now()}`,
        },
      };
    })()
  );
};

export const sendNewsletterWinnerEmail = async (to, data = {}) => {
  const productName = (data?.productName && String(data.productName).trim()) || 'Retatrutide 40mg pen';
  const claimDeadline = (data?.claimDeadline && String(data.claimDeadline).trim()) || '14 days';
  const claimUrl = (data?.claimUrl && String(data.claimUrl).trim()) || `mailto:${env('EMAIL_FROM_EMAIL', 'info@alluvi.org')}?subject=Giveaway%20winner%20-%20claim%20my%20prize`;
  // Conversational subject — avoid emoji/all-caps in subject which classifiers flag as bulk
  const subject = data?.subject || `Good news about the Alluvi giveaway`;

  const text = [
    `Hi,`,
    ``,
    `Brilliant news — your email was drawn for this month's giveaway.`,
    `The free ${productName} is yours.`,
    ``,
    `To claim, reply to this email within ${claimDeadline} with your delivery`,
    `address. We'll ship the next working day. After ${claimDeadline} the prize`,
    `rolls over to next month's draw.`,
    ``,
    `Claim link: ${claimUrl}`,
    ``,
    `Cheers,`,
    `The Alluvi team`,
    `https://alluvi.org`,
    ``,
    `--`,
    `Alluvi products are for in vitro R&D only. If you didn't enter the`,
    `giveaway, ignore this email and we'll redraw.`,
  ].join('\n');

  return await sendEmail(
    to,
    subject,
    'newsletter_winner',
    data,
    (() => {
      const nm = getAlluviLogoInlineAttachmentForNodemailer();
      const mj = getAlluviLogoInlineAttachmentForMailjet();
      return {
        attachments: nm ? [nm] : [],
        mailjetInlineAttachments: mj ? [mj] : [],
        text,
        headers: {
          // Winner is technically transactional — no unsubscribe required, but including it
          // doesn't hurt and is a positive signal to Gmail's classifier.
          'List-Unsubscribe': `<${NEWSLETTER_UNSUBSCRIBE_MAILTO}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Entity-Ref-ID': `newsletter-winner-${Date.now()}`,
        },
      };
    })()
  );
};
