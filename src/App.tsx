/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Heart, 
  Zap, 
  Sword, 
  Backpack, 
  Save, 
  RotateCcw, 
  Coins, 
  TreePine, 
  Home, 
  FlaskConical,
  X,
  Play,
  Volume2,
  VolumeX,
  Map as MapIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants ---
const WORLD_SIZE = 2000;
const TILE_SIZE = 50;
const PLAYER_SIZE = 32;
const ENEMY_SIZE = 32;
const VIEW_DISTANCE = 600; // For spatial optimization
const MAX_ENEMIES = 20;
const MAX_TREES = 40;
const MAX_BUILDINGS = 5;

const ITEM_ICONS: { [key: string]: React.ReactNode } = {
  potion: <FlaskConical className="text-pink-400" />,
  wood: <TreePine className="text-amber-600" />,
};

// --- Types ---
interface Vector2 {
  x: number;
  y: number;
}

interface Item {
  id: string;
  name: string;
  count: number;
  type: 'resource' | 'consumable';
}

interface Entity {
  id: string;
  pos: Vector2;
  health: number;
  maxHealth: number;
}

interface Player extends Entity {
  stamina: number;
  maxStamina: number;
  inventory: Item[];
  coins: number;
  direction: 'up' | 'down' | 'left' | 'right';
  isMoving: boolean;
  isAttacking: boolean;
  attackTimer: number;
  animFrame: number;
}

interface Enemy extends Entity {
  type: 'zombie';
  state: 'wander' | 'chase' | 'attack';
  targetPos: Vector2;
  wanderTimer: number;
  knockback: Vector2;
  hitTimer: number;
}

interface WorldObject {
  id: string;
  type: 'tree' | 'building';
  pos: Vector2;
  size: Vector2;
}

// --- Sound Synthesis ---
let bgmOsc: OscillatorNode | null = null;
let bgmGain: GainNode | null = null;

const playSound = (type: 'attack' | 'pickup' | 'hit' | 'bgm') => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    if (type === 'bgm') {
      if (bgmOsc) return;
      bgmOsc = ctx.createOscillator();
      bgmGain = ctx.createGain();
      bgmOsc.type = 'sine';
      bgmOsc.frequency.setValueAtTime(60, ctx.currentTime);
      bgmGain.gain.setValueAtTime(0.02, ctx.currentTime);
      bgmOsc.connect(bgmGain);
      bgmGain.connect(ctx.destination);
      bgmOsc.start();
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;

    if (type === 'attack') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.1);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'pickup') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'hit') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, now);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    }
  } catch (e) {
    console.warn('Audio context failed', e);
  }
};

const stopBGM = () => {
  if (bgmOsc) {
    try {
      bgmOsc.stop();
    } catch (e) {}
    bgmOsc = null;
    bgmGain = null;
  }
};

interface WorldItem {
  id: string;
  type: 'coin' | 'wood' | 'potion';
  pos: Vector2;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameover'>('menu');
  const [showInventory, setShowInventory] = useState(false);
  const [player, setPlayer] = useState<Player>({
    id: 'player',
    pos: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 },
    health: 100,
    maxHealth: 100,
    stamina: 100,
    maxStamina: 100,
    inventory: [],
    coins: 0,
    direction: 'down',
    isMoving: false,
    isAttacking: false,
    attackTimer: 0,
    animFrame: 0,
  });

  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [worldObjects, setWorldObjects] = useState<WorldObject[]>([]);
  const [worldItems, setWorldItems] = useState<WorldItem[]>([]);
  const [joystick, setJoystick] = useState<Vector2 | null>(null);
  const [keys, setKeys] = useState<{ [key: string]: boolean }>({});
  
  const requestRef = useRef<number>(null);
  const lastTimeRef = useRef<number>(0);

  const [isMuted, setIsMuted] = useState(false);
  const [showMap, setShowMap] = useState(false);

  const toggleMute = () => {
    if (isMuted) {
      playSound('bgm');
      setIsMuted(false);
    } else {
      stopBGM();
      setIsMuted(true);
    }
  };

  // --- Initialization ---
  const initGame = useCallback(() => {
    if (!isMuted) playSound('bgm');
    // Generate World Objects
    const objects: WorldObject[] = [];
    for (let i = 0; i < MAX_TREES; i++) {
      objects.push({
        id: `tree-${i}`,
        type: 'tree',
        pos: { x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE },
        size: { x: 40, y: 40 },
      });
    }
    for (let i = 0; i < MAX_BUILDINGS; i++) {
      objects.push({
        id: `building-${i}`,
        type: 'building',
        pos: { x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE },
        size: { x: 100, y: 100 },
      });
    }
    setWorldObjects(objects);

    // Generate Enemies
    const initialEnemies: Enemy[] = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      initialEnemies.push({
        id: `enemy-${i}`,
        type: 'zombie',
        pos: { x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE },
        health: 50,
        maxHealth: 50,
        state: 'wander',
        targetPos: { x: 0, y: 0 },
        wanderTimer: 0,
        knockback: { x: 0, y: 0 },
        hitTimer: 0,
      });
    }
    setEnemies(initialEnemies);
    setWorldItems([]);
    setPlayer({
      id: 'player',
      pos: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 },
      health: 100,
      maxHealth: 100,
      stamina: 100,
      maxStamina: 100,
      inventory: [],
      coins: 0,
      direction: 'down',
      isMoving: false,
      isAttacking: false,
      attackTimer: 0,
      animFrame: 0,
    });
    setGameState('playing');
  }, []);

  // --- Save / Load ---
  const saveGame = () => {
    const data = {
      player: {
        pos: player.pos,
        health: player.health,
        stamina: player.stamina,
        inventory: player.inventory,
        coins: player.coins
      },
      enemies: enemies.map(e => ({ pos: e.pos, health: e.health })),
      items: worldItems
    };
    localStorage.setItem('rpg_save', JSON.stringify(data));
    alert('Game Saved!');
  };

  const loadGame = () => {
    const saved = localStorage.getItem('rpg_save');
    if (saved) {
      const data = JSON.parse(saved);
      setPlayer(prev => ({ ...prev, ...data.player }));
      setEnemies(prev => prev.map((e, i) => data.enemies[i] ? { ...e, ...data.enemies[i] } : e));
      setWorldItems(data.items || []);
      setGameState('playing');
      alert('Game Loaded!');
    }
  };

  // --- Input Handling ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => setKeys(prev => ({ ...prev, [e.key.toLowerCase()]: true }));
    const handleKeyUp = (e: KeyboardEvent) => setKeys(prev => ({ ...prev, [e.key.toLowerCase()]: false }));
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const handleAttack = () => {
    if (player.stamina >= 20 && !player.isAttacking) {
      setPlayer(prev => ({ 
        ...prev, 
        isAttacking: true, 
        attackTimer: 20, 
        stamina: Math.max(0, prev.stamina - 20) 
      }));
      playSound('attack');
    }
  };

  // --- Game Loop ---
  const update = useCallback((deltaTime: number) => {
    if (gameState !== 'playing') return;

    setPlayer(prev => {
      let dx = 0;
      let dy = 0;
      const speed = 3;

      if (keys['w'] || keys['arrowup']) dy -= 1;
      if (keys['s'] || keys['arrowdown']) dy += 1;
      if (keys['a'] || keys['arrowleft']) dx -= 1;
      if (keys['d'] || keys['arrowright']) dx += 1;

      if (joystick) {
        dx = joystick.x;
        dy = joystick.y;
      }

      const isMoving = dx !== 0 || dy !== 0;
      let newX = prev.pos.x + dx * speed;
      let newY = prev.pos.y + dy * speed;

      newX = Math.max(0, Math.min(WORLD_SIZE, newX));
      newY = Math.max(0, Math.min(WORLD_SIZE, newY));

      let direction = prev.direction;
      if (Math.abs(dx) > Math.abs(dy)) {
        direction = dx > 0 ? 'right' : 'left';
      } else if (Math.abs(dy) > 0) {
        direction = dy > 0 ? 'down' : 'up';
      }

      const stamina = Math.min(prev.maxStamina, prev.stamina + 0.2);
      const attackTimer = Math.max(0, prev.attackTimer - 1);
      const isAttacking = attackTimer > 0;
      const animFrame = isMoving ? (prev.animFrame + 0.1) % 4 : 0;

      return {
        ...prev,
        pos: { x: newX, y: newY },
        isMoving,
        direction,
        stamina,
        attackTimer,
        isAttacking,
        animFrame
      };
    });

    // Update Enemies
    setEnemies(prevEnemies => {
      const updatedEnemies = prevEnemies.map(enemy => {
        const distToPlayer = Math.sqrt(
          Math.pow(enemy.pos.x - player.pos.x, 2) + 
          Math.pow(enemy.pos.y - player.pos.y, 2)
        );

        if (distToPlayer > VIEW_DISTANCE) return enemy;

        let { x: ex, y: ey } = enemy.pos;
        let { x: kx, y: ky } = enemy.knockback;
        let state = enemy.state;
        let wanderTimer = enemy.wanderTimer;
        let targetPos = enemy.targetPos;
        let hitTimer = Math.max(0, enemy.hitTimer - 1);

        if (distToPlayer < 200) {
          state = distToPlayer < 40 ? 'attack' : 'chase';
        } else {
          state = 'wander';
        }

        if (state === 'chase') {
          const angle = Math.atan2(player.pos.y - ey, player.pos.x - ex);
          ex += Math.cos(angle) * 1.5;
          ey += Math.sin(angle) * 1.5;
        } else if (state === 'wander') {
          if (wanderTimer <= 0) {
            targetPos = { 
              x: Math.max(0, Math.min(WORLD_SIZE, ex + (Math.random() - 0.5) * 200)),
              y: Math.max(0, Math.min(WORLD_SIZE, ey + (Math.random() - 0.5) * 200))
            };
            wanderTimer = 100 + Math.random() * 200;
          } else {
            const angle = Math.atan2(targetPos.y - ey, targetPos.x - ex);
            ex += Math.cos(angle) * 0.5;
            ey += Math.sin(angle) * 0.5;
            wanderTimer--;
          }
        }

        ex += kx;
        ey += ky;
        kx *= 0.8;
        ky *= 0.8;

        let health = enemy.health;
        if (player.isAttacking && player.attackTimer === 10) {
          const attackRange = 65;
          if (distToPlayer < attackRange) {
            health -= 25;
            const angle = Math.atan2(ey - player.pos.y, ex - player.pos.x);
            kx = Math.cos(angle) * 15;
            ky = Math.sin(angle) * 15;
            hitTimer = 10;
            playSound('hit');
          }
        }

        if (state === 'attack' && Math.random() < 0.02) {
          setPlayer(p => ({ ...p, health: Math.max(0, p.health - 5) }));
          playSound('hit');
        }

        return {
          ...enemy,
          pos: { x: ex, y: ey },
          health,
          state,
          wanderTimer,
          targetPos,
          knockback: { x: kx, y: ky },
          hitTimer
        };
      });

      // Handle enemy death and drops
      const deadEnemies = updatedEnemies.filter(e => e.health <= 0);
      if (deadEnemies.length > 0) {
        setWorldItems(prev => [
          ...prev,
          ...deadEnemies.map(e => ({
            id: `item-${Date.now()}-${Math.random()}`,
            type: Math.random() > 0.3 ? 'coin' : 'potion' as any,
            pos: e.pos
          }))
        ]);
      }

      return updatedEnemies.filter(e => e.health > 0);
    });

    // Update World Items (Pickup)
    setWorldItems(prevItems => {
      const remainingItems: WorldItem[] = [];
      let coinsToAdd = 0;
      let itemsToAdd: Item[] = [];

      prevItems.forEach(item => {
        const dist = Math.sqrt(Math.pow(item.pos.x - player.pos.x, 2) + Math.pow(item.pos.y - player.pos.y, 2));
        if (dist < 40) {
          playSound('pickup');
          if (item.type === 'coin') {
            coinsToAdd += 10;
          } else {
            itemsToAdd.push({
              id: item.type,
              name: item.type.charAt(0).toUpperCase() + item.type.slice(1),
              count: 1,
              type: item.type === 'potion' ? 'consumable' : 'resource'
            });
          }
        } else {
          remainingItems.push(item);
        }
      });

      if (coinsToAdd > 0 || itemsToAdd.length > 0) {
        setPlayer(prev => {
          const newInventory = [...prev.inventory];
          itemsToAdd.forEach(newItem => {
            const existing = newInventory.find(i => i.id === newItem.id);
            if (existing) {
              existing.count += 1;
            } else {
              newInventory.push(newItem);
            }
          });
          return { ...prev, coins: prev.coins + coinsToAdd, inventory: newInventory };
        });
      }

      return remainingItems;
    });

    if (player.health <= 0) {
      setGameState('gameover');
    }
  }, [gameState, player.pos, player.isAttacking, player.attackTimer, keys, joystick]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const camX = player.pos.x - canvas.width / 2;
    const camY = player.pos.y - canvas.height / 2;

    ctx.fillStyle = '#2d5a27'; 
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(-camX, -camY);

    // Draw Tiles
    for (let x = 0; x < WORLD_SIZE; x += TILE_SIZE) {
      for (let y = 0; y < WORLD_SIZE; y += TILE_SIZE) {
        if (x + TILE_SIZE > camX && x < camX + canvas.width && y + TILE_SIZE > camY && y < camY + canvas.height) {
          // Water patches
          if ((x + y) % 700 < 100) {
            ctx.fillStyle = '#1e88e5';
            ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          } else {
            ctx.strokeStyle = 'rgba(0,0,0,0.03)';
            ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
          }
        }
      }
    }

    // Draw Items
    worldItems.forEach(item => {
      if (item.pos.x > camX && item.pos.x < camX + canvas.width && item.pos.y > camY && item.pos.y < camY + canvas.height) {
        ctx.fillStyle = item.type === 'coin' ? '#ffc107' : item.type === 'potion' ? '#e91e63' : '#795548';
        ctx.beginPath();
        ctx.arc(item.pos.x, item.pos.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    // Draw World Objects
    worldObjects.forEach(obj => {
      if (obj.pos.x + obj.size.x > camX && obj.pos.x < camX + canvas.width && obj.pos.y + obj.size.y > camY && obj.pos.y < camY + canvas.height) {
        if (obj.type === 'tree') {
          ctx.fillStyle = '#3e2723';
          ctx.fillRect(obj.pos.x + 15, obj.pos.y + 20, 10, 20);
          ctx.fillStyle = '#1b5e20';
          ctx.beginPath();
          ctx.moveTo(obj.pos.x + 20, obj.pos.y);
          ctx.lineTo(obj.pos.x, obj.pos.y + 30);
          ctx.lineTo(obj.pos.x + 40, obj.pos.y + 30);
          ctx.fill();
        } else {
          ctx.fillStyle = '#4527a0';
          ctx.fillRect(obj.pos.x, obj.pos.y, obj.size.x, obj.size.y);
          ctx.fillStyle = '#7e57c2';
          ctx.fillRect(obj.pos.x + 5, obj.pos.y + 5, obj.size.x - 10, obj.size.y - 10);
          ctx.fillStyle = '#ffeb3b';
          ctx.fillRect(obj.pos.x + 40, obj.pos.y + 60, 20, 40); // Door
        }
      }
    });

    // Draw Enemies
    enemies.forEach(enemy => {
      if (enemy.pos.x + ENEMY_SIZE > camX && enemy.pos.x < camX + canvas.width && enemy.pos.y + ENEMY_SIZE > camY && enemy.pos.y < camY + canvas.height) {
        ctx.fillStyle = enemy.hitTimer > 0 ? '#ff5252' : '#2e7d32'; 
        ctx.fillRect(enemy.pos.x - ENEMY_SIZE/2, enemy.pos.y - ENEMY_SIZE/2, ENEMY_SIZE, ENEMY_SIZE);
        ctx.fillStyle = 'red';
        ctx.fillRect(enemy.pos.x - 15, enemy.pos.y - 25, 30, 4);
        ctx.fillStyle = 'green';
        ctx.fillRect(enemy.pos.x - 15, enemy.pos.y - 25, (enemy.health / enemy.maxHealth) * 30, 4);
      }
    });

    // Draw Player (Animated)
    ctx.save();
    ctx.translate(player.pos.x, player.pos.y);
    
    // Body
    ctx.fillStyle = '#1565c0';
    ctx.fillRect(-12, -16, 24, 32);
    
    // Head
    ctx.fillStyle = '#ffccbc';
    ctx.fillRect(-8, -28, 16, 16);
    
    // Legs (Animation)
    const legOffset = Math.sin(player.animFrame * Math.PI) * 8;
    ctx.fillStyle = '#0d47a1';
    ctx.fillRect(-10, 16, 8, 8 + (player.isMoving ? legOffset : 0));
    ctx.fillRect(2, 16, 8, 8 + (player.isMoving ? -legOffset : 0));

    // Sword
    if (player.isAttacking) {
      ctx.strokeStyle = '#cfd8dc';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      const angle = player.direction === 'right' ? 0 : player.direction === 'left' ? Math.PI : player.direction === 'up' ? -Math.PI/2 : Math.PI/2;
      ctx.rotate(angle + (player.attackTimer / 20) * Math.PI - Math.PI/2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(40, 0);
      ctx.stroke();
    }
    
    ctx.restore();

    ctx.restore();
  }, [player, enemies, worldObjects, worldItems]);

  const animate = useCallback((time: number) => {
    const deltaTime = time - lastTimeRef.current;
    lastTimeRef.current = time;
    update(deltaTime);
    render();
    requestRef.current = requestAnimationFrame(animate);
  }, [update, render]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [animate]);

  // --- Resize Handler ---
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- Joystick Logic ---
  const handleJoystickStart = (e: React.TouchEvent | React.MouseEvent) => {
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    if (clientX < 200 && clientY > window.innerHeight - 200) {
      setJoystick({ x: 0, y: 0 });
    }
  };

  const handleJoystickMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (!joystick) return;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const centerX = 100;
    const centerY = window.innerHeight - 100;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = 50;
    
    const nx = dx / (dist || 1);
    const ny = dy / (dist || 1);
    const power = Math.min(dist, maxDist) / maxDist;
    
    setJoystick({ x: nx * power, y: ny * power });
  };

  const handleJoystickEnd = () => setJoystick(null);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black font-sans text-white select-none touch-none">
      <canvas 
        ref={canvasRef} 
        className="block w-full h-full"
        onMouseDown={handleJoystickStart}
        onMouseMove={handleJoystickMove}
        onMouseUp={handleJoystickEnd}
        onTouchStart={handleJoystickStart}
        onTouchMove={handleJoystickMove}
        onTouchEnd={handleJoystickEnd}
      />

      {/* --- UI Overlays --- */}
      
      {/* HUD */}
      {gameState === 'playing' && (
        <div className="absolute top-4 left-4 flex flex-col gap-3 pointer-events-none">
          <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md p-2 rounded-xl border border-white/10">
            <Heart className="text-red-500 w-5 h-5 fill-red-500" />
            <div className="w-32 h-3 bg-gray-800 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-red-500" 
                initial={{ width: '100%' }}
                animate={{ width: `${player.health}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md p-2 rounded-xl border border-white/10">
            <Zap className="text-yellow-500 w-5 h-5 fill-yellow-500" />
            <div className="w-32 h-3 bg-gray-800 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-yellow-500" 
                initial={{ width: '100%' }}
                animate={{ width: `${player.stamina}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1 rounded-xl border border-white/10">
            <Coins className="text-amber-400 w-4 h-4" />
            <span className="text-sm font-mono">{player.coins}</span>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      {gameState === 'playing' && (
        <>
          {/* Joystick Visual */}
          {joystick && (
            <div className="absolute bottom-24 left-24 w-24 h-24 rounded-full border-2 border-white/20 bg-white/5 flex items-center justify-center">
              <div 
                className="w-10 h-10 rounded-full bg-white/40"
                style={{ 
                  transform: `translate(${joystick.x * 30}px, ${joystick.y * 30}px)` 
                }}
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="absolute bottom-8 right-8 flex flex-col gap-4">
            <button 
              onClick={handleAttack}
              className="w-16 h-16 rounded-full bg-red-600/80 backdrop-blur-md border-2 border-red-400 flex items-center justify-center active:scale-90 transition-transform shadow-lg"
            >
              <Sword className="w-8 h-8" />
            </button>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowInventory(true)}
                className="w-12 h-12 rounded-full bg-indigo-600/80 backdrop-blur-md border border-indigo-400 flex items-center justify-center active:scale-90 transition-transform"
              >
                <Backpack className="w-6 h-6" />
              </button>
              <button 
                onClick={saveGame}
                className="w-12 h-12 rounded-full bg-emerald-600/80 backdrop-blur-md border border-emerald-400 flex items-center justify-center active:scale-90 transition-transform"
              >
                <Save className="w-6 h-6" />
              </button>
              <button 
                onClick={toggleMute}
                className="w-12 h-12 rounded-full bg-zinc-600/80 backdrop-blur-md border border-zinc-400 flex items-center justify-center active:scale-90 transition-transform"
              >
                {isMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
              </button>
              <button 
                onClick={() => setShowMap(true)}
                className="w-12 h-12 rounded-full bg-blue-600/80 backdrop-blur-md border border-blue-400 flex items-center justify-center active:scale-90 transition-transform"
              >
                <MapIcon className="w-6 h-6" />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Menu / Game Over Screens */}
      <AnimatePresence>
        {gameState === 'menu' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/80 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center"
          >
            <h1 className="text-6xl font-black tracking-tighter mb-2 italic text-emerald-400">ELYSIUM QUEST</h1>
            <p className="text-gray-400 mb-12 max-w-md">Survive the zombie-infested wilderness, collect resources, and build your legend in this open-world RPG.</p>
            <div className="flex flex-col gap-4 w-full max-w-xs">
              <button 
                onClick={initGame}
                className="flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-4 rounded-2xl transition-all active:scale-95"
              >
                <Play className="fill-current" /> START ADVENTURE
              </button>
              <button 
                onClick={loadGame}
                className="flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 border border-white/10 py-4 rounded-2xl transition-all active:scale-95"
              >
                <RotateCcw className="w-5 h-5" /> LOAD SAVE
              </button>
            </div>
          </motion.div>
        )}

        {gameState === 'gameover' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 bg-red-950/90 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center"
          >
            <h2 className="text-7xl font-black tracking-tighter mb-4 text-red-500">YOU DIED</h2>
            <p className="text-red-200/60 mb-12">The wilderness claimed another soul.</p>
            <button 
              onClick={initGame}
              className="flex items-center justify-center gap-2 bg-white text-black font-bold px-12 py-4 rounded-2xl transition-all active:scale-95"
            >
              TRY AGAIN
            </button>
          </motion.div>
        )}

        {showMap && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute inset-0 bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 z-50"
          >
            <div className="w-full max-w-2xl aspect-square bg-zinc-900 rounded-3xl border border-white/10 overflow-hidden shadow-2xl relative">
              <div className="p-6 border-b border-white/5 flex justify-between items-center absolute top-0 left-0 right-0 bg-zinc-900/80 backdrop-blur-md z-10">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <MapIcon className="text-blue-400" /> WORLD MAP
                </h3>
                <button onClick={() => setShowMap(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="w-full h-full p-12 pt-24 flex items-center justify-center">
                <div 
                  className="relative bg-emerald-900/30 border border-white/10 rounded-xl overflow-hidden"
                  style={{ width: '100%', height: '100%', maxWidth: '500px', maxHeight: '500px' }}
                >
                  {/* Map Scale: 500px / 2000px = 0.25 */}
                  {/* World Objects on Map */}
                  {worldObjects.map(obj => (
                    <div 
                      key={obj.id}
                      className="absolute rounded-sm"
                      style={{
                        left: `${(obj.pos.x / WORLD_SIZE) * 100}%`,
                        top: `${(obj.pos.y / WORLD_SIZE) * 100}%`,
                        width: `${(obj.size.x / WORLD_SIZE) * 100}%`,
                        height: `${(obj.size.y / WORLD_SIZE) * 100}%`,
                        backgroundColor: obj.type === 'tree' ? '#1b5e20' : '#4527a0',
                        minWidth: '2px',
                        minHeight: '2px'
                      }}
                    />
                  ))}
                  
                  {/* Enemies on Map */}
                  {enemies.map(enemy => (
                    <div 
                      key={enemy.id}
                      className="absolute w-1 h-1 bg-red-500 rounded-full"
                      style={{
                        left: `${(enemy.pos.x / WORLD_SIZE) * 100}%`,
                        top: `${(enemy.pos.y / WORLD_SIZE) * 100}%`,
                      }}
                    />
                  ))}
                  
                  {/* Player on Map */}
                  <motion.div 
                    className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 z-10"
                    animate={{ scale: [1, 1.5, 1] }}
                    transition={{ repeat: Infinity, duration: 1 }}
                    style={{
                      left: `${(player.pos.x / WORLD_SIZE) * 100}%`,
                      top: `${(player.pos.y / WORLD_SIZE) * 100}%`,
                      transform: 'translate(-50%, -50%)'
                    }}
                  />
                </div>
              </div>
              
              <div className="absolute bottom-6 left-0 right-0 text-center text-xs text-gray-500 uppercase tracking-widest">
                {WORLD_SIZE} x {WORLD_SIZE} PIXELS
              </div>
            </div>
          </motion.div>
        )}

        {showInventory && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute inset-0 bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 z-50"
          >
            <div className="w-full max-w-lg bg-zinc-900 rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
              <div className="p-6 border-b border-white/5 flex justify-between items-center">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <Backpack className="text-indigo-400" /> INVENTORY
                </h3>
                <button onClick={() => setShowInventory(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="p-6 grid grid-cols-4 gap-4 max-h-[60vh] overflow-y-auto">
                {player.inventory.length === 0 ? (
                  <div className="col-span-4 py-12 text-center text-gray-500">
                    Your backpack is empty...
                  </div>
                ) : (
                  player.inventory.map(item => (
                    <div key={item.id} className="aspect-square bg-white/5 rounded-2xl border border-white/5 flex flex-col items-center justify-center relative group hover:bg-white/10 transition-colors">
                      {ITEM_ICONS[item.id] || <Backpack className="text-gray-400" />}
                      <span className="text-[10px] mt-1 text-gray-400 uppercase tracking-widest">{item.name}</span>
                      <div className="absolute top-1 right-2 text-xs font-mono text-indigo-400">{item.count}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="p-6 bg-black/40 border-t border-white/5 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Coins className="text-amber-400 w-5 h-5" />
                  <span className="font-mono text-lg">{player.coins}</span>
                </div>
                <div className="text-xs text-gray-500 uppercase tracking-widest">
                  {player.inventory.length} / 20 SLOTS
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
