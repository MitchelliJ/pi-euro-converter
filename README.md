# pi-euro-converter

A [pi](https://pi.dev) extension that replaces the default footer with a faithful
copy showing the running session cost in **euros** instead of US dollars.

- USD→EUR rate fetched once per day from the ECB-backed
  [Frankfurter API](https://www.frankfurter.app) (free, no API key).
- Cached to `~/.pi/agent/euro-rate.json`; the latest cached rate is reused when
  offline.
- Mirrors pi's built-in footer.
- Euro amount rounded to 2 decimals.

## Install

```bash
pi install git:github.com/MitchelliJ/pi-euro-converter
```

Or pin to a tag/commit:

```bash
pi install git:github.com/MitchelliJ/pi-euro-converter@v1.0.1
```

Try without installing:

```bash
pi -e git:github.com/MitchelliJ/pi-euro-converter
```

After installing, run `/reload` in pi (or restart it).

## Uninstall

```bash
pi remove git:github.com/MitchelliJ/pi-euro-converter
```

## License

MIT
