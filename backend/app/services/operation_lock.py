import asyncio

# All user-triggered BOSS reads and local candidate deletions share this gate.
manual_read_lock = asyncio.Lock()
