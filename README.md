# HRU service app

An unofficial Android service app for the Itho Daalderop **HRU 400 / 375 / 300** ventilation units with the Wi-Fi module.
It talks to the unit over the unit's own Wi-Fi, like Itho's service app does, and adds a few things that app lacks.

> **Use at your own risk.** This project is not made, approved or supported by Itho Daalderop. It writes settings
> and can install firmware on your unit. A failed or interrupted update can leave the unit unusable and may affect
> your warranty. Nobody here is responsible for what happens to your unit. Back up your settings first.

## What it does

- **Connect** to the unit's Wi-Fi (`ID-Gateway-<serial>`) from inside the app, or detect that you already are.
  The Wi-Fi password can be read over Bluetooth, scanned from the sticker QR code, or typed.
- **Live data, settings (with sliders), manual control, error codes** from the same catalog the original app uses.
- **Paired RF devices**: list them, start/stop pairing, delete all bindings.
- **Sensors library**: scan the sticker on an RF sensor and give it a name and type. The unit only knows addresses,
  so this is your own notes, kept on the phone. Works without a connection to the unit.
- **Several units**: save more than one (name, article number, serial, Wi-Fi login, last-read versions), all viewable offline.
- **Firmware**: shows the installed and the latest available BASE and Wi-Fi module versions, downloads firmware
  from [the firmware repo](https://github.com/william-sy/esphome-Itho-Daalderop-HRU400/tree/main/firmware_update)
  (over mobile data is fine) and installs it with the same flow as Itho's app. Like Itho's app, it only offers
  firmware the catalog lists for the unit's software version (and, if you scanned the unit's sticker, its model).
- **Backup and restore** of all settings, with the share sheet.

There are no release notes for any Itho firmware, so an update is a blind update. Treat it that way.

## Status

Verified on a real unit (HRU 400): connecting, reading and writing settings, live data, paired devices, sticker
scanning. Not (or only partly) verified: installing firmware from the app, reading the Wi-Fi password over Bluetooth.
Other models are untested. If you try it, please open an issue with what happened.

## Install

1. Download the latest `hru-service-vX.Y.Z.apk` from the [Releases](../../releases) page on your phone.
2. Open it. Android asks to allow installs from your browser or file manager. Allow it for this one install.
3. Optional: check the download against the `.sha256` file on the release.

Android 10 or newer is needed for joining the unit's Wi-Fi from inside the app. Older versions can join in Android settings.
Sticker scanning uses Google's code scanner and needs Google Play services (it downloads a small module once).

## Build from source

Needs Node 20+, JDK 17 and the Android SDK.

```sh
npm ci
./build.sh            # builds hru-service.apk (debug)
./build.sh install    # also installs it on a phone connected over adb
npm test              # headless smoke test of the web part
```

The app is a [Capacitor](https://capacitorjs.com) project: the UI is plain HTML and JavaScript in `www/`, and a small
native plugin (`android/app/src/main/java/nl/hru/service/DeviceHttpPlugin.java`) sends HTTP over the unit's Wi-Fi even
though that network has no internet. Bluetooth uses `@capacitor-community/bluetooth-le`, scanning uses
`@capacitor-mlkit/barcode-scanning`.

The firmware list built into the app is a copy of `firmware_metadata.json` from the firmware repo. `scripts/prepare.sh`
refreshes it before every build; the app itself fetches the live list when you tap "Check GitHub for firmware".

## Releasing

The pipeline in `.github/workflows/build.yml`:

- on every push and pull request: runs `npm test` and builds a debug APK (kept as a workflow artifact for 14 days);
- on a tag like `v1.2.0`: runs the tests, builds a **signed** release APK, and publishes a GitHub Release with the APK
  and its checksum.

```sh
git tag v1.2.0
git push origin v1.2.0
```

Releases are signed with a key that lives in repository secrets. The key must stay the same for every release: Android
refuses to update an installed app that is signed with a different key (the user would have to uninstall and lose the
saved units and sensor names). Create it once and **keep a backup outside GitHub**:

```sh
keytool -genkeypair -v -keystore hru-release.jks -alias hru -keyalg RSA -keysize 2048 -validity 10000
base64 -i hru-release.jks | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS          # hru
gh secret set ANDROID_KEY_PASSWORD
```

A tag without these secrets fails on purpose, with a message saying so.

## License

Public domain, see [LICENSE](LICENSE).
