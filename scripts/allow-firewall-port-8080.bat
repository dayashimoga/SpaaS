@echo off
:: Batch script to elevate and configure Windows Defender Firewall for SPaaS (Port 8080)
title SPaaS Firewall Configuration (Port 8080)

net session >nul 2>&1
if %errorLevel% == 0 (
    echo ==============================================================
    echo  SPaaS Universal Edge Compute Fabric - Firewall Setup
    echo ==============================================================
    echo.
    echo [1/2] Adding inbound firewall rule for TCP port 8080...
    netsh advfirewall firewall delete rule name="SPaaS Control Plane (Port 8080)" >nul 2>&1
    netsh advfirewall firewall add rule name="SPaaS Control Plane (Port 8080)" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
    if %errorLevel% == 0 (
        echo  [OK] Inbound rule created: Port 8080 ALLOWED on all profiles (Public, Private).
    ) else (
        echo  [ERROR] Failed to add firewall rule.
    )

    echo.
    echo [2/2] Setting local Wi-Fi connection profile to Private...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi*' | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue" >nul 2>&1
    echo  [OK] Wi-Fi network marked as Private.

    echo.
    echo ==============================================================
    echo  SUCCESS! Windows Firewall is now open for SPaaS port 8080.
    echo.
    echo  You can now open Chrome on your Android phone and visit:
    echo     http://192.168.0.111:8080
    echo ==============================================================
    echo.
    pause
) else (
    echo Requesting Administrator privileges to update Windows Firewall...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
)
