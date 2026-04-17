const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const express = require('express')
const { Boom } = require('@hapi/boom')

const app = express()
app.use(express.json())

const WEBHOOK_URL = process.env.WEBHOOK_URL
const API_KEY = process.env.API_KEY || 'adaptel2026'
const PORT = process.env.PORT || 3000

let sock = null
let qrCode = null
let isConnected = false

function auth(req, res, next) {
  const key = req.headers['x-api-key']
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr
      isConnected = false
      console.log('QR Code prêt — scanne depuis ton téléphone')
    }

    if (connection === 'close') {
      isConnected = false
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log('Reconnexion...')
        startWhatsApp()
      }
    }

    if (connection === 'open') {
      isConnected = true
      qrCode = null
      console.log('WhatsApp connecté')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg || msg.key.fromMe) return

    const sender = msg.key.remoteJid?.replace('@s.whatsapp.net', '')
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

    if (!sender || !text) return

    if (WEBHOOK_URL) {
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'whatsapp:received',
            payload: {
              sender: `+${sender}`,
              text,
              messageId: msg.key.id,
              timestamp: new Date().toISOString(),
            },
          }),
        })
      } catch (e) {
        console.error('Webhook error:', e.message)
      }
    }
  })
}

// QR Code
app.get('/qr', auth, (req, res) => {
  if (isConnected) return res.json({ connected: true })
  if (!qrCode) return res.json({ waiting: true })
  res.json({ qr: qrCode })
})

// Statut
app.get('/status', auth, (req, res) => {
  res.json({ connected: isConnected })
})

// Envoi message
app.post('/send', auth, async (req, res) => {
  const { phoneNumber, message } = req.body
  if (!phoneNumber || !message) return res.status(400).json({ error: 'phoneNumber et message requis' })
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp non connecté' })

  try {
    const jid = phoneNumber.replace('+', '') + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Bridge démarré sur port ${PORT}`)
  startWhatsApp()
})