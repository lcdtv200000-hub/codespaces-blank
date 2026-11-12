/**
 * Aternos Minecraft Automated Worker Bot
 * Framework: Mineflayer + mineflayer-pathfinder
 * 
 * Features:
 * 1. Lifecycle & Activation via chat: `/active` command (Strict 12-hour timer).
 * 2. Default Background Task: 32-block radius wood collection + random wandering.
 * 3. Dynamic Task Interruption: `/task collect "X" stack "item_name"`.
 * 4. Equipment & Inventory Management: Auto tool equip + deposit to chest near spawn.
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear, GoalXZ } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

// ================= CONFIGURATION =================
const CONFIG = {
    host: 'ICFAIUniversity.aternos.me', // Aternos server host/domain
    port: 19132,                       // Default Java port (Mineflayer will auto-resolve Aternos SRV)
    username: 'WorkerBot',             // Bot name in game
    version: false,                    // false = auto-detect server version, or specify like '1.20.1'
    auth: 'offline',                   // 'offline' for cracked Aternos servers, 'microsoft' for premium

    // Task & Logic Settings
    searchRadius: 32,                  // Block search radius for logs
    spawnChestRadius: 20,              // Radius near spawn to search for storage chest
    activeDurationMs: 12 * 60 * 60 * 1000, // 12 Hours in milliseconds (43,200,000 ms)
    invFullThreshold: 3                // Threshold of empty slots before dumping to chest
};

// ================= STATE MANAGEMENT =================
let bot = null;
let mcData = null;
let defaultMovements = null;

let isActive = false;
let sessionTimeout = null;
let sessionStartTime = null;

let isBusy = false;                    // Flag to prevent overlapping task loops
let spawnPosition = null;              // Captured on initial spawn

// Dynamic task state: { type: 'collect', item: 'oak_log', targetCount: 128, startCount: 0 }
let dynamicTask = null;

// ================= BOT INITIALIZATION =================
function createBot() {
    console.log(`[Connecting] Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}...`);

    bot = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: CONFIG.username,
        version: CONFIG.version || undefined,
        auth: CONFIG.auth
    });

    bot.loadPlugin(pathfinder);

    // Event: Bot spawns in the world
    bot.on('spawn', () => {
        console.log(`[Spawned] Bot joined the game at ${bot.entity.position}`);
        mcData = require('minecraft-data')(bot.version);
        defaultMovements = new Movements(bot, mcData);
        defaultMovements.canDig = true;
        bot.pathfinder.setMovements(defaultMovements);

        // Record spawn position
        if (!spawnPosition) {
            spawnPosition = bot.entity.position.clone();
            console.log(`[Spawn Location] Saved spawn coordinates: ${spawnPosition}`);
        }

        bot.chat('WorkerBot ready. Type /active to start my 12-hour session.');
    });

    // Event: In-game Chat handler
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        handleChatCommand(username, message.trim());
    });

    // Event: Error & Reconnection handling
    bot.on('error', (err) => {
        console.error('[Error]', err);
    });

    bot.on('end', (reason) => {
        console.warn(`[Disconnected] Reason: ${reason}. Attempting reconnect in 15 seconds...`);
        cleanupTimers();
        setTimeout(createBot, 15000);
    });

    // Event: Periodic worker loop tick
    setInterval(() => {
        if (isActive && !isBusy) {
            workerLoop();
        }
    }, 2000);
}

// ================= CHAT COMMANDS =================
function handleChatCommand(username, message) {
    // 1. /active Command Handler
    if (message.toLowerCase() === '/active') {
        if (isActive) {
            const elapsed = Date.now() - sessionStartTime;
            const remaining = Math.max(0, CONFIG.activeDurationMs - elapsed);
            const hours = (remaining / (1000 * 60 * 60)).toFixed(2);
            bot.chat(`I am already active! Remaining time: ${hours} hours.`);
            return;
        }

        startActiveSession();
        bot.chat(`WorkerBot activated! 12-hour timer started. Commencing tasks.`);
        return;
    }

    // 2. /task collect command handler
    // Supports both:
    // - /task collect 2 stack oak_log (Bina quotes ke)
    // - /task collect "2" stack "oak_log" (Quotes ke sath)
    // - Also supports 'stacks' or 'stacks of'
    const taskMatch = message.match(/^\/task\s+collect\s+["']?(\d+)["']?\s+(?:stacks?)(?:\s+of)?\s+["']?([a-zA-Z0-9_]+)["']?/i);
    if (taskMatch) {
        if (!isActive) {
            bot.chat('Please activate me first using /active before assigning tasks.');
            return;
        }

        const stackCount = parseInt(taskMatch[1], 10);
        let itemName = taskMatch[2].toLowerCase();

        // Standard stack size = 64 items
        const targetTotal = stackCount * 64;
        const currentItemCount = countItemInInventory(itemName);

        dynamicTask = {
            type: 'collect',
            itemName: itemName,
            targetCount: targetTotal,
            startCount: currentItemCount
        };

        bot.chat(`Task accepted: Collect ${targetTotal}x ${itemName} (${stackCount} stack(s)). Interrupting current task!`);
        console.log(`[Task Interrupted] Dynamic task assigned: ${JSON.stringify(dynamicTask)}`);
        
        // Stop current pathfinding and immediately trigger worker loop
        bot.pathfinder.stop();
        return;
    }

    // Optional status check command
    if (message.toLowerCase() === '/status') {
        if (!isActive) {
            bot.chat('Status: IDLE (Waiting for /active)');
        } else {
            const taskDesc = dynamicTask 
                ? `Dynamic Task (${countItemInInventory(dynamicTask.itemName)}/${dynamicTask.targetCount} ${dynamicTask.itemName})` 
                : 'Default Task (Wood Collection)';
            bot.chat(`Status: ACTIVE | Current Mode: ${taskDesc}`);
        }
    }
}

// ================= SESSION LIFECYCLE =================
function startActiveSession() {
    isActive = true;
    sessionStartTime = Date.now();

    console.log('[Lifecycle] 12-hour session initiated.');

    cleanupTimers();

    // 12-Hour strict timeout (43,200,000 ms)
    sessionTimeout = setTimeout(() => {
        isActive = false;
        isBusy = false;
        dynamicTask = null;
        bot.pathfinder.stop();
        console.log('[Lifecycle] 12-hour session expired. Going IDLE.');
        bot.chat('12-hour session has expired! WorkerBot is now IDLE.');
    }, CONFIG.activeDurationMs);
}

function cleanupTimers() {
    if (sessionTimeout) {
        clearTimeout(sessionTimeout);
        sessionTimeout = null;
    }
}

// ================= MAIN WORKER LOOP =================
async function workerLoop() {
    if (!isActive || isBusy) return;
    isBusy = true;

    try {
        // Step 1: Check Inventory Threshold
        if (bot.inventory.emptySlotCount() <= CONFIG.invFullThreshold) {
            console.log('[Inventory] Threshold reached. Depositing items to spawn chest...');
            bot.chat('My inventory is getting full. Going to spawn chest to deposit resources.');
            await handleChestDeposit();
            isBusy = false;
            return;
        }

        // Step 2: Handle Dynamic Task if present
        if (dynamicTask && dynamicTask.type === 'collect') {
            const currentCount = countItemInInventory(dynamicTask.itemName);
            if (currentCount >= dynamicTask.targetCount) {
                bot.chat(`Dynamic task complete! Collected ${currentCount}x ${dynamicTask.itemName}. Resuming default wood collection.`);
                console.log(`[Task Finished] Dynamic task for ${dynamicTask.itemName} completed.`);
                dynamicTask = null;
            } else {
                await executeHarvest(dynamicTask.itemName);
                isBusy = false;
                return;
            }
        }

        // Step 3: Default Background Task (Wood Collection)
        await executeWoodCollection();

    } catch (err) {
        console.error('[WorkerLoop Error]', err.message);
    } finally {
        isBusy = false;
    }
}

// ================= HARVESTING & WOOD COLLECTION =================
async function executeWoodCollection() {
    // Array of log block names
    const logNames = [
        'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 
        'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
        'crimson_stem', 'warped_stem'
    ];

    const targetBlock = bot.findBlock({
        matching: (block) => block && logNames.includes(block.name),
        maxDistance: CONFIG.searchRadius
    });

    if (targetBlock) {
        console.log(`[Wood Collection] Found ${targetBlock.name} at ${targetBlock.position}`);
        await mineBlock(targetBlock, 'axe');
        await collectNearbyDrops();
    } else {
        console.log('[Wood Collection] No logs within 32 blocks. Wandering...');
        await randomWander();
    }
}

async function executeHarvest(itemName) {
    // If the task item is a block (like stone, oak_log, iron_ore, dirt, etc.)
    const targetBlock = bot.findBlock({
        matching: (block) => block && (block.name === itemName || block.name.includes(itemName)),
        maxDistance: CONFIG.searchRadius
    });

    if (targetBlock) {
        const preferredTool = itemName.includes('log') || itemName.includes('wood') ? 'axe' : 'pickaxe';
        await mineBlock(targetBlock, preferredTool);
        await collectNearbyDrops();
    } else {
        console.log(`[Dynamic Task] Target block ${itemName} not found nearby. Wandering to search...`);
        await randomWander();
    }
}

// ================= MINING & TOOLS =================
async function mineBlock(block, preferredToolType) {
    try {
        // Equip appropriate tool if available in inventory
        await equipTool(preferredToolType);

        // Pathfind close to block (distance: 3 blocks)
        await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));

        // Dig target block
        if (bot.canDigBlock(block)) {
            await bot.dig(block);
            console.log(`[Mined] Successfully mined ${block.name}`);
        }
    } catch (err) {
        console.warn(`[MineBlock Warning] Could not mine block: ${err.message}`);
    }
}

async function equipTool(toolType) {
    try {
        const item = bot.inventory.items().find(i => i.name.includes(toolType));
        if (item && bot.heldItem?.name !== item.name) {
            await bot.equip(item, 'hand');
            console.log(`[Equip] Equipped ${item.name}`);
        }
    } catch (err) {
        // Silently continue if tool equip fails
    }
}

async function collectNearbyDrops() {
    try {
        // Wait slightly for block drop entity to spawn
        await bot.waitForTicks(10);

        const dropEntity = Object.values(bot.entities).find(e => 
            e.name === 'item' && 
            e.position.distanceTo(bot.entity.position) <= 6
        );

        if (dropEntity) {
            await bot.pathfinder.goto(new GoalNear(dropEntity.position.x, dropEntity.position.y, dropEntity.position.z, 0.5));
            await bot.waitForTicks(5);
        }
    } catch (err) {
        // Drop collection is best-effort
    }
}

// ================= INVENTORY & CHEST MANAGEMENT =================
async function handleChestDeposit() {
    try {
        const searchCenter = spawnPosition || bot.entity.position;

        // Search for a chest within spawnChestRadius (20 blocks)
        const chestBlock = bot.findBlock({
            point: searchCenter,
            matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel'),
            maxDistance: CONFIG.spawnChestRadius
        });

        if (!chestBlock) {
            console.warn('[Deposit] No chest found within 20 blocks of spawn point!');
            bot.chat('Notice: I cannot find a chest near spawn to deposit items.');
            return;
        }

        console.log(`[Deposit] Moving to chest at ${chestBlock.position}`);
        await bot.pathfinder.goto(new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));

        const chest = await bot.openContainer(chestBlock);
        console.log('[Deposit] Chest opened. Transferring gathered resources...');

        // Deposit resources, but keep tools, weapons, armor, and essential food
        const itemsToDeposit = bot.inventory.items().filter(item => !isEssentialItem(item.name));

        for (const item of itemsToDeposit) {
            try {
                await chest.deposit(item.type, null, item.count);
                console.log(`[Deposited] ${item.count}x ${item.name}`);
            } catch (depErr) {
                console.warn(`[Deposit] Chest might be full or slot blocked: ${depErr.message}`);
                break;
            }
        }

        await bot.waitForTicks(10);
        chest.close();
        bot.chat('Deposited all collected resources into the storage chest.');
    } catch (err) {
        console.error('[Deposit Error]', err.message);
    }
}

function isEssentialItem(name) {
    const essentialKeywords = [
        'axe', 'pickaxe', 'shovel', 'sword', 'hoe',
        'helmet', 'chestplate', 'leggings', 'boots', 'shield',
        'bread', 'cooked_', 'apple', 'torch'
    ];
    return essentialKeywords.some(keyword => name.includes(keyword));
}

function countItemInInventory(itemName) {
    let count = 0;
    for (const item of bot.inventory.items()) {
        if (item.name === itemName || item.name.includes(itemName)) {
            count += item.count;
        }
    }
    return count;
}

// ================= WANDERING =================
async function randomWander() {
    try {
        const angle = Math.random() * Math.PI * 2;
        const distance = 10 + Math.random() * 10;
        const targetX = bot.entity.position.x + Math.cos(angle) * distance;
        const targetZ = bot.entity.position.z + Math.sin(angle) * distance;

        await bot.pathfinder.goto(new GoalXZ(targetX, targetZ));
    } catch (err) {
        // Wandering is best effort
    }
}

// ================= START BOT =================
createBot();

