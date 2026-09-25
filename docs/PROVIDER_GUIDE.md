# SPaaS Mobile Provider Guide

## 1. Volunteering Idle Smartphone Compute
As a smartphone owner, you contribute spare computing capacity (when your device is idle, charging, or connected to home Wi-Fi) and earn verifiable compute credits.

---

## 2. Privacy & Safety Guarantees
- **No Private Data Access**: The SPaaS Android app operates without permissions for contacts, photos, SMS, camera, microphone, or external storage.
- **Immediate User Override**: A persistent, prominent notification is displayed whenever the service is running, offering instant **PAUSE** and **STOP** buttons.
- **Automatic Resource Yielding**:
  - Unplugging the charger immediately pauses execution (if "Only while charging" is enabled).
  - Leaving home Wi-Fi and entering cellular network suspends execution (preventing mobile data charges).
  - High battery temperature immediately yields compute to prevent device thermal throttling.
  - Low battery state automatically suspends the agent.

---

## 3. Configuring Owner Safeguards
Inside the Android app:
1. **Run only while charging**: Recommended (default ON).
2. **Run only on unmetered Wi-Fi**: Recommended (default ON).
3. **Minimum Battery Cutoff**: Set slider between 20% and 80%.
4. **Thermal Cutoff**: Select `LIGHT` or `MODERATE` to guarantee the phone stays cool to the touch.
