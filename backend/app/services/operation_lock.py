import asyncio

# User-triggered BOSS reads, confirmed recommendation greetings and local deletions share this gate.
manual_read_lock = asyncio.Lock()
