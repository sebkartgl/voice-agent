import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS and headers for WebSocket
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Voice Agent Server Running');
});

// Test endpoint for WebSocket info
app.get('/ws-test', (req, res) => {
  res.json({
    message: 'WebSocket endpoint is at /ws',
    url: `wss://${req.headers.host}/ws`,
    status: 'ready'
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Twilio Media Stream WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio Media Stream connected at', new Date().toISOString());
  
  let streamSid = null;
  let openaiWs = null;
  
  // Connect to OpenAI Realtime API
  function connectToOpenAI() {
    const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17';
    
    openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API at', new Date().toISOString());
      
      // Configure the session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful AI assistant answering phone calls. Be concise, friendly, and professional. Ask how you can help them.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_sample_rate: 16000,
          output_audio_sample_rate: 16000,
          input_audio_transcription: {
            model: 'whisper-1'
          }
        }
      }));
    });

    openaiWs.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'response.audio.delta') {
        // Convert OpenAI PCM16 to Twilio mulaw and send back
        const audioData = Buffer.from(message.delta, 'base64');
        const mulawData = pcmToMulaw(audioData);
        
        console.log(`Sending ${mulawData.length} bytes mulaw to Twilio`);
        
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: mulawData.toString('base64')
            }
          }));
        }
      }
      
      if (message.type === 'session.created') {
        console.log('OpenAI session created');
      }
      
      if (message.type === 'error') {
        console.error('OpenAI error:', message.error);
      }
    });

    openaiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error at', new Date().toISOString(), ':', error.message || error);
    });

    openaiWs.on('close', () => {
      console.log('OpenAI connection closed');
    });
  }

  // Handle Twilio Media Stream messages
  twilioWs.on('message', (message) => {
    const msg = JSON.parse(message.toString());
    
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        console.log(`Stream started: ${streamSid}`);
        connectToOpenAI();
        break;
        
      case 'media':
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          // Convert Twilio mulaw to OpenAI PCM16
          const audioData = Buffer.from(msg.media.payload, 'base64');
          const pcmData = mulawToPcm(audioData);
          
          console.log(`Received ${audioData.length} bytes mulaw, converted to ${pcmData.length} bytes PCM`);
          
          // Send to OpenAI
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcmData.toString('base64')
          }));
          
          // Commit after accumulating enough audio (500ms worth)
          if (!twilioWs.audioFrameCount) {
            twilioWs.audioFrameCount = 0;
          }
          twilioWs.audioFrameCount++;
          
          // Commit every 20 frames (approximately 400ms at 20ms per frame)
          if (twilioWs.audioFrameCount >= 20) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.commit'
            }));
            twilioWs.audioFrameCount = 0;
            console.log('Committed audio buffer to OpenAI');
          }
        }
        break;
        
      case 'stop':
        console.log(`Stream stopped: ${streamSid}`);
        if (openaiWs) {
          openaiWs.close();
        }
        break;
    }
  });

  twilioWs.on('error', (error) => {
    console.error('Twilio WebSocket error:', error.message || error);
  });

  twilioWs.on('close', () => {
    console.log('Twilio Media Stream disconnected at', new Date().toISOString());
    if (openaiWs) {
      openaiWs.close();
    }
  });
});

// Audio conversion functions
function mulawToPcm(mulawData) {
  // Convert mulaw to PCM16 at 8kHz first
  const pcm8k = Buffer.alloc(mulawData.length * 2);
  
  for (let i = 0; i < mulawData.length; i++) {
    const mulaw = mulawData[i];
    let linear = mulawToLinear(mulaw);
    pcm8k.writeInt16LE(linear, i * 2);
  }
  
  // Upsample from 8kHz to 16kHz (2x interpolation with smoothing)
  const samplesIn = pcm8k.length / 2;
  const pcm16k = Buffer.alloc(samplesIn * 2 * 2);
  
  for (let i = 0; i < samplesIn; i++) {
    const currentSample = pcm8k.readInt16LE(i * 2);
    const nextSample = (i + 1 < samplesIn) ? pcm8k.readInt16LE((i + 1) * 2) : currentSample;
    
    const outputIndex = i * 2;
    
    // Linear interpolation between samples
    const interpolatedSample = Math.round((currentSample + nextSample) / 2);
    
    pcm16k.writeInt16LE(currentSample, outputIndex * 2);
    pcm16k.writeInt16LE(interpolatedSample, (outputIndex + 1) * 2);
  }
  
  return pcm16k;
}

function pcmToMulaw(pcmData) {
  // Downsample from 16kHz to 8kHz (take every 2nd sample with smoothing)
  const samplesIn = pcmData.length / 2;
  const samplesOut = Math.floor(samplesIn / 2);
  const pcm8k = Buffer.alloc(samplesOut * 2);
  
  for (let i = 0; i < samplesOut; i++) {
    const inputIndex = i * 2;
    
    // Average 2 samples for better quality
    const sample1 = pcmData.readInt16LE(inputIndex * 2);
    const sample2 = (inputIndex + 1 < samplesIn) ? pcmData.readInt16LE((inputIndex + 1) * 2) : sample1;
    
    const avgSample = Math.round((sample1 + sample2) / 2);
    // Clamp to 16-bit range
    const clampedSample = Math.max(-32768, Math.min(32767, avgSample));
    pcm8k.writeInt16LE(clampedSample, i * 2);
  }
  
  // Convert PCM16 to mulaw
  const mulawData = Buffer.alloc(pcm8k.length / 2);
  
  for (let i = 0; i < pcm8k.length; i += 2) {
    const linear = pcm8k.readInt16LE(i);
    const mulaw = linearToMulaw(linear);
    mulawData[i / 2] = mulaw;
  }
  
  return mulawData;
}

function mulawToLinear(mulaw) {
  mulaw = ~mulaw;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  
  let linear = (mantissa << 1) + 33;
  linear <<= exponent + 2;
  
  return sign ? -linear : linear;
}

function linearToMulaw(linear) {
  const sign = linear < 0 ? 0x80 : 0;
  linear = Math.abs(linear);
  
  if (linear > 32767) linear = 32767;
  
  linear += 33;
  
  let exponent = 7;
  for (let i = 0x4000; i > 0; i >>= 1) {
    if (linear >= i) {
      linear -= i;
      break;
    }
    exponent--;
  }
  
  const mantissa = linear >> (exponent + 3);
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  
  return mulaw & 0xFF;
}

console.log('Voice Agent server initialized...');