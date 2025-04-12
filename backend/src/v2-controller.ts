import express from 'express';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as os from 'os';
import cors from 'cors';

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

// WebSocket connection status
enum ConnectionStatus {
  CONNECTED,
  RECONNECTING,
  CLOSED
}

// WebSocket connection with status
interface WebSocketConnection extends WebSocket {
  status?: ConnectionStatus;
  clientId?: string; // Unique identifier for client
  lastActivity?: number; // Timestamp of last activity
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
    loadFactor: number; // Normalized load factor (0-1)
    idleTime: number; // Time (ms) since this chunk has been considered low-load
  };
  status: 'active' | 'draining' | 'closing'; // Status to track chunk lifecycle
}

class LoadBalancer extends EventEmitter {
  private chunks: Map<string, Chunk> = new Map();
  private basePort: number = 3000;
  private maxChunks: number = 64;
  private metricsInterval: NodeJS.Timeout | null = null;
  private errorHandler: ErrorHandler;
  
  // Configuration parameters
  private readonly LOAD_THRESHOLD_HIGH = 0.75; // Threshold for scale-up
  private readonly LOAD_THRESHOLD_LOW = 0.2; // Threshold for scale-down
  private readonly MIN_CHUNKS = 1; // Minimum number of chunks to maintain
  private readonly IDLE_TIME_THRESHOLD = 60000; // 1 minute of low load before scale-down
  
  constructor() {
    super();
    this.errorHandler = new ErrorHandler(this);
    
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
    wss.on('connection', (ws: WebSocketConnection) => {
      // Assign a unique client ID
      ws.clientId = `client-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      ws.status = ConnectionStatus.CONNECTED;
      ws.lastActivity = Date.now();
      
      const shardId = this.selectShardForChunk(chunkId);
      const shard = this.getChunk(chunkId).shards.get(shardId)!;
      
      shard.connections.add(ws);
      shard.metrics.connectionCount++;
      
      // Ping-pong mekanizması
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (err) {
            this.errorHandler.handleWebsocketError(err, ws, chunkId, shardId);
          }
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
      
      ws.on('message', (message: string) => {
        try {
          // Update last activity timestamp
          ws.lastActivity = Date.now();
          
          // Her mesaj alındığında mesaj oranını artır
          shard.metrics.messageRate++;
          
          // Burada mesaj işleme mantığı olabilir
          this.handleMessage(message, chunkId, shardId, ws);
        } catch (err) {
          this.errorHandler.handleWebsocketError(err, ws, chunkId, shardId);
        }
      });
      
      ws.on('close', () => {
        shard.connections.delete(ws);
        shard.metrics.connectionCount--;
        clearInterval(pingInterval);
      });
      
      ws.on('error', (err) => {
        this.errorHandler.handleWebsocketError(err, ws, chunkId, shardId);
      });
      
      ws.on('pong', () => {
        ws.lastActivity = Date.now();
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
        cpuUsage: 0,
        loadFactor: 0,
        idleTime: 0
      },
      status: 'active'
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
      // Skip chunks that are draining or closing
      if (chunk.status !== 'active') {
        continue;
      }
      
      // Yük puanını hesapla
      const load = chunk.metrics.loadFactor;
      
      if (load < minLoad) {
        minLoad = load;
        leastLoadedChunk = chunk;
      }
    }
    
    if (!leastLoadedChunk) {
      // If no active chunks, create a new one
      console.log("No active chunks available, creating a new one.");
      return this.createChunk();
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
      // Skip if the chunk is being closed
      if (chunk.status === 'closing') {
        continue;
      }
      
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
      
      // Calculate load factor (normalized between 0-1)
      chunk.metrics.loadFactor = 
        (chunk.metrics.totalConnections / 200) * 0.4 + // Assuming 200 connections is "full"
        (chunk.metrics.averageMessageRate / 100) * 0.4 + // Assuming 100 msg/s is "full"
        chunk.metrics.cpuUsage * 0.2;
      
      // Update idle time tracking for scale-down
      if (chunk.metrics.loadFactor < this.LOAD_THRESHOLD_LOW) {
        if (chunk.metrics.idleTime === 0) {
          chunk.metrics.idleTime = Date.now();
        }
      } else {
        chunk.metrics.idleTime = 0;
      }
    }
    
    // Yük kontrolü yap ve gerekirse ölçeklendir
    this.checkLoadAndScale();
  }
  
  // Yük durumuna göre ölçeklendirme
  private checkLoadAndScale(): void {
    // Check if scale-up is needed
    this.checkForScaleUp();
    
    // Check if scale-down is needed
    this.checkForScaleDown();
  }
  
  // Check if we need to scale up
  private checkForScaleUp(): void {
    // En yüklü chunk'ı bul
    let maxLoad = -1;
    let highLoadCount = 0;
    
    for (const [_, chunk] of this.chunks.entries()) {
      if (chunk.status !== 'active') continue;
      
      if (chunk.metrics.loadFactor > maxLoad) {
        maxLoad = chunk.metrics.loadFactor;
      }
      
      if (chunk.metrics.loadFactor > this.LOAD_THRESHOLD_HIGH) {
        highLoadCount++;
      }
    }
    
    // Eğer yük belirli bir eşiği aşmışsa yeni chunk oluştur
    if ((maxLoad > this.LOAD_THRESHOLD_HIGH || highLoadCount >= Math.ceil(this.chunks.size * 0.5)) 
        && this.chunks.size < this.maxChunks) {
      console.log(`High load detected (${maxLoad.toFixed(2)}). Creating a new chunk...`);
      this.createChunk();
      this.emit('scaling', { action: 'scale-up', currentChunks: this.chunks.size });
    }
  }
  
  // Check if we need to scale down
  private checkForScaleDown(): void {
    // If we're at minimum chunks, don't scale down
    if (this.getActiveChunkCount() <= this.MIN_CHUNKS) {
      return;
    }
    
    const now = Date.now();
    let lowLoadChunks: Chunk[] = [];
    
    // Find chunks with low load for enough time
    for (const [_, chunk] of this.chunks.entries()) {
      if (chunk.status !== 'active') continue;
      
      if (chunk.metrics.idleTime > 0 && (now - chunk.metrics.idleTime) > this.IDLE_TIME_THRESHOLD) {
        lowLoadChunks.push(chunk);
      }
    }
    
    // If we have more than one low load chunk, consider merging
    if (lowLoadChunks.length > 1) {
      console.log(`Found ${lowLoadChunks.length} low-load chunks. Attempting to merge...`);
      this.mergeChunks(lowLoadChunks);
    }
  }
  
  // Get count of active chunks
  private getActiveChunkCount(): number {
    let count = 0;
    for (const [_, chunk] of this.chunks.entries()) {
      if (chunk.status === 'active') {
        count++;
      }
    }
    return count;
  }
  
  // Merge low-load chunks
  private mergeChunks(lowLoadChunks: Chunk[]): void {
    // Sort chunks by load factor (lowest first)
    lowLoadChunks.sort((a, b) => a.metrics.loadFactor - b.metrics.loadFactor);
    
    // We'll keep the first chunk and merge others into it
    const targetChunk = lowLoadChunks[0];
    const chunksToMerge = lowLoadChunks.slice(1);
    
    console.log(`Merging ${chunksToMerge.length} chunks into ${targetChunk.id}`);
    
    for (const sourceChunk of chunksToMerge) {
      // Mark chunk as draining (no new connections)
      sourceChunk.status = 'draining';
      
      // Migrate all connections from source chunk to target chunk
      this.migrateConnections(sourceChunk, targetChunk);
      
      // After a delay to allow migration, close the source chunk
      setTimeout(() => {
        this.closeChunk(sourceChunk.id);
      }, 10000); // Give 10 seconds for migration
    }
    
    this.emit('scaling', { 
      action: 'scale-down', 
      currentChunks: this.chunks.size,
      mergedChunks: chunksToMerge.map(c => c.id),
      targetChunk: targetChunk.id
    });
  }
  
  // Migrate connections from one chunk to another
  private migrateConnections(sourceChunk: Chunk, targetChunk: Chunk): void {
    // For each shard in the source chunk
    for (const [_, sourceShard] of sourceChunk.shards.entries()) {
      // Get all active connections
      const connections = Array.from(sourceShard.connections);
      
      for (const ws of connections) {
        try {
          // Notify client about redirection
          const targetShardId = this.selectShardForChunk(targetChunk.id);
          
          // Send redirection info to client
          ws.send(JSON.stringify({
            type: 'redirect',
            targetChunkId: targetChunk.id,
            targetPort: targetChunk.port,
            connectionUrl: `ws://localhost:${targetChunk.port}`,
            targetShard: targetShardId
          }));
          
          // Close current connection (client should reconnect to new chunk)
          ws.close(1000, 'Chunk optimization - please reconnect to provided endpoint');
          
        } catch (err) {
          console.error(`Error during connection migration: ${err}`);
        }
      }
    }
  }
  
  // Close a chunk completely
  private closeChunk(chunkId: string): void {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      console.error(`Cannot close: Chunk with id ${chunkId} not found!`);
      return;
    }
    
    // Mark as closing
    chunk.status = 'closing';
    
    // Force close any remaining connections
    for (const [_, shard] of chunk.shards.entries()) {
      for (const ws of shard.connections) {
        try {
          ws.close(1000, 'Chunk shutting down');
        } catch (err) {
          console.error(`Error closing connection: ${err}`);
        }
      }
    }
    
    // Close servers
    chunk.server.close(() => {
      console.log(`Chunk ${chunkId} server closed successfully`);
    });
    
    chunk.wss.close(() => {
      console.log(`Chunk ${chunkId} WebSocket server closed successfully`);
    });
    
    // Remove from chunks map
    this.chunks.delete(chunkId);
    console.log(`Chunk ${chunkId} has been removed from the system`);
  }
  
  // Gelen mesajları işleme
  private handleMessage(message: string, chunkId: string, shardId: string, ws: WebSocketConnection): void {
    try {
      const data = JSON.parse(message.toString());
      
      // Check for health check message
      if (data.type === 'health_check') {
        ws.send(JSON.stringify({
          type: 'health_response',
          status: 'ok',
          chunkId,
          shardId,
          timestamp: Date.now()
        }));
        return;
      }
      
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
    // Only return active chunks
    const activeChunks = Array.from(this.chunks.values())
      .filter(chunk => chunk.status === 'active');
    
    if (activeChunks.length === 0) {
      return this.createChunk();
    }
    
    // Sort by load (lowest first)
    activeChunks.sort((a, b) => a.metrics.loadFactor - b.metrics.loadFactor);
    
    return activeChunks[0];
  }
  
  // Tüm sistem hakkında genel bilgileri al
  getSystemInfo(): object {
    const chunksInfo = Array.from(this.chunks.entries()).map(([id, chunk]) => {
      return {
        id,
        port: chunk.port,
        status: chunk.status,
        shardCount: chunk.shards.size,
        connections: chunk.metrics.totalConnections,
        load: {
          connections: chunk.metrics.totalConnections,
          messageRate: chunk.metrics.averageMessageRate,
          cpuUsage: chunk.metrics.cpuUsage,
          loadFactor: chunk.metrics.loadFactor
        },
        idleTime: chunk.metrics.idleTime > 0 ? 
          Math.floor((Date.now() - chunk.metrics.idleTime) / 1000) + "s" : 
          "0s"
      };
    });
    
    return {
      totalChunks: this.chunks.size,
      activeChunks: this.getActiveChunkCount(),
      maxChunks: this.maxChunks,
      totalConnections: chunksInfo.reduce((sum, info) => sum + info.connections, 0),
      systemLoad: {
        cpu: os.loadavg()[0] / os.cpus().length,
        memory: process.memoryUsage().heapUsed / 1024 / 1024, // MB
      },
      chunks: chunksInfo
    };
  }
  
  // Check client health and reconnect if needed
  checkClientHealth(_clientId: string): { isHealthy: boolean, reconnectInfo?: any } {
    // Implement client health check logic
    return { isHealthy: true };
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

// Error handler class for improved error management
class ErrorHandler {
  private loadBalancer: LoadBalancer;
  private errorCounts: Map<string, number> = new Map(); // Track errors by client
  
  constructor(loadBalancer: LoadBalancer) {
    this.loadBalancer = loadBalancer;
  }
  
  // Handle WebSocket errors
  handleWebsocketError(error: any, ws: WebSocketConnection, chunkId: string, shardId: string): void {
    console.error(`WebSocket error in ${chunkId}/${shardId}: ${error.message || 'Unknown error'}`);
    
    // Track error for this client
    if (ws.clientId) {
      const currentCount = this.errorCounts.get(ws.clientId) || 0;
      this.errorCounts.set(ws.clientId, currentCount + 1);
      
      // If too many errors, suggest reconnection
      if (currentCount >= 3) {
        this.handleReconnection(ws, chunkId);
      }
    }
    
    // Try to send error to client
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          status: 'error',
          error: error.message || 'Unknown error',
          timestamp: Date.now()
        }));
      }
    } catch (sendError) {
      console.error(`Failed to send error message: ${sendError}`);
    }
  }
  
  // Handle client reconnection
  private handleReconnection(ws: WebSocketConnection, currentChunkId: string): void {
    try {
      // Get optimal chunk for reconnection (might be different from current)
      const targetChunk = this.loadBalancer.getOptimalChunkForNewConnection();
      
      // If we're already on the optimal chunk, no need to redirect
      if (targetChunk.id === currentChunkId) {
        return;
      }
      
      // Send reconnection info to client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'reconnect',
          reason: 'connection_instability',
          targetChunkId: targetChunk.id,
          targetPort: targetChunk.port,
          connectionUrl: `ws://localhost:${targetChunk.port}`
        }));
        
        // Change status to reconnecting
        ws.status = ConnectionStatus.RECONNECTING;
        
        // Close after a short delay to allow client to process message
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Reconnection recommended');
          }
        }, 100);
      }
    } catch (err) {
      console.error(`Reconnection handling error: ${err}`);
    }
  }
  
  // Reset error count for client
  resetErrorCount(clientId: string): void {
    this.errorCounts.delete(clientId);
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
    
    // Health check for a specific client
    this.app.get('/api/client/:clientId/health', (req, res) => {
      try {
        const clientId = req.params.clientId;
        const healthStatus = this.loadBalancer.checkClientHealth(clientId);
        
        if (healthStatus.isHealthy) {
          res.json({
            status: 'healthy',
            clientId
          });
        } else {
          res.json({
            status: 'unhealthy',
            clientId,
            reconnectInfo: healthStatus.reconnectInfo
          });
        }
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
      
      if (info.action === 'scale-down') {
        console.log(`Merged chunks: ${info.mergedChunks.join(', ')} into ${info.targetChunk}`);
      }
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