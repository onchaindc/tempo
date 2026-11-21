# start-low-res.ps1 — launch TEMPO with lower camera throughput
$env:TEMPO_CAMERA_WIDTH = "640"
$env:TEMPO_CAMERA_HEIGHT = "480"
$env:TEMPO_CAMERA_FPS = "30"
Write-Host "Starting TEMPO with 640x480 @ 30 fps"
npm start
