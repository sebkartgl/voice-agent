import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 8080;

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Voice Agent Server Running');
});

// Add a test TwiML endpoint
app.post('/twiml', (req, res) => {
  console.log('TwiML request received');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, this is a test. The WebSocket connection will be established next.</Say>
  <Connect>
    <Stream url="wss://voice-agent-550289000405.europe-west2.run.app/ws" track="both_tracks"/>
  </Connect>
</Response>`);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Twilio Media Stream WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('WebSocket connected at', new Date().toISOString());
  
  ws.on('message', (message) => {
    const msg = JSON.parse(message.toString());
    console.log('Received event:', msg.event);
    
    if (msg.event === 'start') {
      console.log('Stream started:', msg.start?.streamSid);
    }
    
    if (msg.event === 'media') {
      // Just log that we're receiving media
      // Don't log every frame to avoid spam
    }
    
    if (msg.event === 'stop') {
      console.log('Stream stopped');
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
  
  ws.on('close', () => {
    console.log('WebSocket closed');
  });
});

console.log('Test server initialized...');