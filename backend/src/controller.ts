import express from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import cors from 'cors'

// Temel yapılar
interface Shard {
  id: string;
  connections: Set<WebSocket>;
  metrics: {
    connectionCount: number;
    messageRate: number;
    cpuUsage: number;
  };
}

interface Chunk {
  id: string;
  port: number;
  server: http.Server;
  wss: WebSocketServer;
  shards: Map<string, Shard>;
  metrics: {
    totalConnections: number;
    averageMessageRate: number;
    cpuUsage: number;
  };
}

class LoadBalancer extends EventEmitter {
  private chunks: Map<string, Chunk> = new Map();
  private basePort: number = 3000;
  private maxChunks: number = 64;
  private metricsInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    super();
    // İlk chunk'ı oluştur
    this.createChunk();
    
    // Metrik toplama işlemini başlat
    this.metricsInterval = setInterval(() => this.collectMetrics(), 5000);
  }
  
  // Yeni bir chunk oluştur
  createChunk(): Chunk {
    if (this.chunks.size >= this.maxChunks) {
      console.warn(`Maximum chunk limit (${this.maxChunks}) reached!`);
      return this.getLeastLoadedChunk();
    }
    
    const chunkId = `chunk-${this.chunks.size + 1}`;
    const port = this.basePort + this.chunks.size;
    
    // Express app oluştur
    const app = express();
    app.use(cors());
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    
    
    // Websocket bağlantılarını yönet
    wss.on('connection', (ws: WebSocket) => {
      const shardId = this.selectShardForChunk(chunkId);
      const shard = this.getChunk(chunkId).shards.get(shardId)!;
      
      shard.connections.add(ws);
      shard.metrics.connectionCount++;
      
      ws.on('message', (message: string) => {
        // Her mesaj alındığında mesaj oranını artır
        shard.metrics.messageRate++;
        
        // Burada mesaj işleme mantığı olabilir
        this.handleMessage(message, chunkId, shardId, ws);
      });
      
      ws.on('close', () => {
        shard.connections.delete(ws);
        shard.metrics.connectionCount--;
      });
    });
    
    // Sunucuyu başlat
    server.listen(port, () => {
      console.log(`Chunk ${chunkId} is listening on port ${port}`);
    });
    
    // Chunk'a ait shardları oluştur
    const shards = new Map<string, Shard>();
    // Her chunk için en az 2 shard oluştur
    const shardCount = Math.max(2, Math.ceil(this.chunks.size / 8)); // Chunk sayısı arttıkça shard sayısı artacak şekilde
    
    for (let i = 1; i <= shardCount; i++) {
      const shardId = `${chunkId}-shard-${i}`;
      shards.set(shardId, {
        id: shardId,
        connections: new Set<WebSocket>(),
        metrics: {
          connectionCount: 0,
          messageRate: 0,
          cpuUsage: 0
        }
      });
    }
    
    const chunk: Chunk = {
      id: chunkId,
      port,
      server,
      wss,
      shards,
      metrics: {
        totalConnections: 0,
        averageMessageRate: 0,
        cpuUsage: 0
      }
    };
    
    this.chunks.set(chunkId, chunk);
    return chunk;
  }
  
  // Chunk'a ait shard seçimi - yük dengeleme için
  private selectShardForChunk(chunkId: string): string {
    const chunk = this.getChunk(chunkId);
    if (!chunk) {
      throw new Error(`Chunk with id ${chunkId} not found!`);
    }
    
    // En az yüklü shardı bul
    let leastLoadedShard: [string, Shard] | null = null;
    let minLoad = Infinity;
    
    for (const [id, shard] of chunk.shards.entries()) {
      const load = shard.metrics.connectionCount * 0.4 + 
                  shard.metrics.messageRate * 0.4 + 
                  shard.metrics.cpuUsage * 0.2;
      
      if (load < minLoad) {
        minLoad = load;
        leastLoadedShard = [id, shard];
      }
    }
    
    return leastLoadedShard![0]; // En az yüklü shardın ID'sini döndür
  }
  
  // En az yüklü chunk'ı al
  getLeastLoadedChunk(): Chunk {
    let leastLoadedChunk: Chunk | null = null;
    let minLoad = Infinity;
    
    for (const [_, chunk] of this.chunks.entries()) {
      // Yük puanını hesapla
      const load = chunk.metrics.totalConnections * 0.4 + 
                 chunk.metrics.averageMessageRate * 0.4 + 
                 chunk.metrics.cpuUsage * 0.2;
      
      if (load < minLoad) {
        minLoad = load;
        leastLoadedChunk = chunk;
      }
    }
    
    if (!leastLoadedChunk) {
      throw new Error("No chunks available!");
    }
    
    return leastLoadedChunk;
  }
  
  // Belirtilen chunk'ı al
  getChunk(chunkId: string): Chunk {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      throw new Error(`Chunk with id ${chunkId} not found!`);
    }
    return chunk;
  }
  
  // Tüm metrikleri topla
  private collectMetrics(): void {
    // Sistem yük metriklerini al
    const systemLoad = os.loadavg()[0] / os.cpus().length; // Normalleştirilmiş CPU yükü (0-1 arasında)
    
    // Her chunk için metrikleri güncelle
    for (const [_, chunk] of this.chunks.entries()) {
      let totalConnections = 0;
      let totalMessageRate = 0;
      
      for (const [_, shard] of chunk.shards.entries()) {
        totalConnections += shard.metrics.connectionCount;
        totalMessageRate += shard.metrics.messageRate;
        
        // CPU kullanımını rastgele simüle et (gerçek uygulamada process.cpuUsage() kullanılabilir)
        shard.metrics.cpuUsage = Math.min(0.2 + systemLoad * 0.8 + Math.random() * 0.2, 1);
        
        // Mesaj oranını sıfırla (5 saniyelik ortalama için)
        setTimeout(() => {
          shard.metrics.messageRate = 0;
        }, 100);
      }
      
      // Chunk metriklerini güncelle
      chunk.metrics.totalConnections = totalConnections;
      chunk.metrics.averageMessageRate = chunk.shards.size > 0 ? totalMessageRate / chunk.shards.size : 0;
      chunk.metrics.cpuUsage = Math.min(systemLoad * 0.8 + Math.random() * 0.2, 1);
    }
    
    // Yük kontrolü yap ve gerekirse yeni chunk oluştur
    this.checkLoadAndScale();
  }
  
  // Yük durumuna göre ölçeklendirme
  private checkLoadAndScale(): void {
    // En yüklü chunk'ı bul
    let maxLoad = -1;
    
    for (const [_, chunk] of this.chunks.entries()) {
      // Yük puanını hesapla
      const load = chunk.metrics.totalConnections * 0.4 + 
                 chunk.metrics.averageMessageRate * 0.4 + 
                 chunk.metrics.cpuUsage * 0.2;
      
      if (load > maxLoad) {
        maxLoad = load;
      }
    }
    
    // Eğer yük belirli bir eşiği aşmışsa yeni chunk oluştur
    const LOAD_THRESHOLD = 1.2; // 0-1 arası bir değer
    if (maxLoad > LOAD_THRESHOLD && this.chunks.size < this.maxChunks) {
      console.log(`High load detected (${maxLoad.toFixed(2)}). Creating a new chunk...`);
      this.createChunk();
      this.emit('scaling', { action: 'scale-up', currentChunks: this.chunks.size });
    }
  }
  
  // Gelen mesajları işleme
  private handleMessage(message: string, chunkId: string, shardId: string, ws: WebSocket): void {
    try {
      const data = JSON.parse(message.toString());
      
      // Burada mesaj işleme mantığı olacak
      // Örnek olarak echo yapıyoruz
      ws.send(JSON.stringify({
        status: 'ok',
        message: data,
        metadata: {
          chunkId,
          shardId,
          timestamp: Date.now()
        }
      }));
      
    } catch (err) {
      ws.send(JSON.stringify({
        status: 'error',
        error: 'Invalid message format'
      }));
    }
  }
  
  // Yeni bir istemci bağlantısı için en uygun chunk'ı seç
  getOptimalChunkForNewConnection(): Chunk {
    return this.getLeastLoadedChunk();
  }
  
  // Tüm sistem hakkında genel bilgileri al
  getSystemInfo(): object {
    const chunksInfo = Array.from(this.chunks.entries()).map(([id, chunk]) => {
      return {
        id,
        port: chunk.port,
        shardCount: chunk.shards.size,
        connections: chunk.metrics.totalConnections,
        load: {
          connections: chunk.metrics.totalConnections,
          messageRate: chunk.metrics.averageMessageRate,
          cpuUsage: chunk.metrics.cpuUsage
        }
      };
    });
    
    return {
      totalChunks: this.chunks.size,
      maxChunks: this.maxChunks,
      totalConnections: chunksInfo.reduce((sum, info) => sum + info.connections, 0),
      chunks: chunksInfo
    };
  }
  
  // Sistemi kapat
  shutdown(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    for (const [_, chunk] of this.chunks.entries()) {
      chunk.server.close();
      chunk.wss.close();
    }
    
    console.log("WebSocket cluster system shut down successfully");
  }
}

// Main Controller - Ana sunucu
class MainController {
  private app: express.Application;
  private server: http.Server;
  private port: number = 2999; // Ana kontrol sunucusu için port
  private loadBalancer: LoadBalancer;
  
  constructor() {
    this.app = express();
    this.app.use(cors({
      origin: ['http://localhost:5000', 'http://127.0.0.1:5000'], // Allow requests from these origins
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));
    this.server = http.createServer(this.app);
    this.loadBalancer = new LoadBalancer();
    
    this.setupRoutes();
    this.setupEventListeners();
  }
  
  private setupRoutes(): void {
    // Ana kontrolcü için API rotaları
    this.app.get('/api/system/info', (_req, res) => {
      res.json(this.loadBalancer.getSystemInfo());
    });
    
    this.app.post('/api/system/scale', (_req, res) => {
      try {
        const chunk = this.loadBalancer.createChunk();
        res.json({
          status: 'success',
          message: `New chunk ${chunk.id} created on port ${chunk.port}`,
          chunkId: chunk.id,
          port: chunk.port
        });
      } catch (err) {
        res.status(500).json({
          status: 'error',
          message: (err as Error).message
        });
      }
    });
    
    // Yeni bir bağlantı için en iyi sunucuyu öner
    this.app.get('/api/connect', (_req, res) => {
      try {
        const chunk = this.loadBalancer.getOptimalChunkForNewConnection();
        res.json({
          status: 'success',
          chunkId: chunk.id, 
          port: chunk.port,
          connectionUrl: `ws://localhost:${chunk.port}`
        });
      } catch (err) {
        res.status(500).json({
          status: 'error',
          message: (err as Error).message
        });
      }
    });
  }
  
  private setupEventListeners(): void {
    this.loadBalancer.on('scaling', (info) => {
      console.log(`Scaling event: ${info.action}. Current chunks: ${info.currentChunks}`);
    });
  }
  
  start(): void {
    this.server.listen(this.port, () => {
      console.log(`Main Controller is running on port ${this.port}`);
      console.log(`First chunk was automatically created. System is ready.`);
    });
  }
  
  shutdown(): void {
    this.loadBalancer.shutdown();
    this.server.close();
    console.log("Main Controller shut down successfully");
  }
}

// Sistemi başlat
const controller = new MainController();
controller.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  controller.shutdown();
  process.exit(0);
});