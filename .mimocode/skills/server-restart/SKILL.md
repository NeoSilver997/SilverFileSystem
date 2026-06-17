---
name: server-restart
description: Safely restart the SilverFileSystem Node.js server — find PID, stop, start in background, verify port
---

# Server Restart

Restart the Express server on port 4001 without blocking the terminal.

## Steps

1. **Find current PID:**
   ```
   netstat -ano | Select-String "4001" | Select-String "LISTENING"
   ```

2. **Stop old process:**
   ```
   Stop-Process -Id <PID> -Force
   Start-Sleep -Seconds 2
   ```

3. **Start in background (non-blocking):**
   ```
   Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\AI_Server\Coding\SilverFileSystem" -WindowStyle Hidden
   ```

4. **Verify it's up (after ~8s):**
   ```
   Start-Sleep -Seconds 8
   netstat -ano | Select-String "4001" | Select-String "LISTENING"
   ```

## Notes

- Server runs on port 4001 (configured in `.env`).
- `JWT_SECRET` warning on restart is expected — users must re-login.
- Use `-WindowStyle Hidden` to avoid blocking the terminal.
- Do NOT use `taskkill /F /IM node.exe` — this kills the agent process too.
- Preload takes ~12-35s (dupGroupMap loading).
