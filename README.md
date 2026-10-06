# GM Office

A pixel-art idle screen of the office, made for the office TV. The team works, takes calls, grabs coffee, holds meetings and eats lunch on Eastern time, and the windows show the live weather. You can click anyone to say hi.

- **TV:** https://timberjones.github.io (click an empty spot for fullscreen; see [On the office TV](#on-the-office-tv))
- **User page:** https://timberjones.github.io/u (walk your own character around the TV from your phone or computer)

## On the office TV

The office TV is an older Samsung running the page in its built-in browser.

- **Fullscreen:** move the remote's pointer to an empty spot (not a person) and click. Click again to leave fullscreen. Enter (the remote's OK button) and F on a keyboard also toggle it.
- **After an update**, refreshing the page picks up the new version. Only if it seems stuck on the old one, add something new to the end of the address, like `timberjones.github.io/?v=4`.
- **If the page can't start**, it shows a red bar with the error and the browser's details instead of a blank screen. Send that text along when asking for a fix.
- **If the browser keeps closing or the screensaver kicks in,** a streaming stick running a kiosk browser (for example Fully Kiosk Browser on a Fire TV Stick) keeps the page up full time.

## URL parameters

Add these to the TV page, for example `timberjones.github.io/?time=12:30&weather=snow`.

**Time and day**
- `?time=14:30` starts the clock at that time and lets it run (`2:30pm` and `14` also work)
- `?hour=14` freezes the clock at that hour (decimals are OK, for example `14.5`)
- `?speed=60` runs the clock 60 times faster
- `?day=tue` previews another weekday (`mon` to `sun`)
- `?tz=America/Chicago` sets the clock's time zone (default `America/Toronto`)

**People and scene**
- `?people=20` sets today's headcount (by default Tue/Thu fills 80-95% of the 31 desks, Mon/Wed/Fri 10-30%, and weekends are empty)
- `?weather=rain` forces `sun`, `cloud`, `rain` or `snow` (default: live Montreal weather from the feed)
- `?dogs=1` brings the poodles in right away (they're only around 9:00-16:30)
- `?delivery=1` sends a food courier in right away
- `?seed=N` fixes the randomness so the day plays out the same way each time

**Speech and live data**
- `?chat=0` turns off speech bubbles
- `?feed=0` doesn't read the activity feed (`?feed=<url>` uses a different one)
- `?relay=0` doesn't listen to the relay, so nobody can drive a character on this screen (`?relay=<wss url>` uses a different one)
- `?user=1234` (or `?user_1234`) opens the user page for that id

**Look and performance**
- `?scale=4` forces the pixel scale (default: as big as fits the screen)
- `?fps=30` sets the frame rate (default 60; lower it for a weak TV)
- `?lofi=0` turns off the warm tint and vignette
- `?hd=0` uses plain 1x sprites, without the HD detail or outlines
- `?ss=2` sets the scene's supersampling level
- `?smooth=1` adds GPU Scale2x smoothing to the final upscale
- `?round=1` rounds the sprite corners (Scale2x)
- `?style=classic` uses navy outlines instead of warm brown

**User page**
- `u?id=1234` opens the user page already signed in as that id

**Keys on the TV page:** N night, D day, C back to the real clock, W cycle the weather, B someone says a line now, F or Enter (remote OK) fullscreen. Clicking an empty spot also toggles fullscreen; clicking a person makes them say hi.

## User page

Open `/u`, type your user id (or `1111`, or "I'm new here", to come in as someone new), then walk with the arrow keys or the on-screen d-pad (tap for one step, hold to keep walking) and use the Sit button. You can also change hair, skin, cap, beard, height and clothes. Your look is saved and shows on every TV. Close the page and your character goes back to its usual routine, or walks out if it isn't in today.

## Tech stack

- **Static pages on GitHub Pages.** `gm-office.html` (the TV) and `gm-user.html` (the user page) are each a single self-contained HTML file using a plain canvas, with no build step or framework. `index.html` and `u.html` are short redirects. The user page reuses the TV's sprites and office layout by loading the code between the `@shared` markers in `gm-office.html`.
- **Works on old TV browsers (about Chrome 51 / 2016 and newer).** The TV's built-in Samsung browser is years behind, and one unsupported feature leaves the screen blank. So `gm-office.html`:
  - starts with a small plain-ES5 script that adds the newer functions the page uses when the browser lacks them (`Array.flatMap`, `String.padStart`, `Object.entries`, and `Intl.DateTimeFormat.formatToParts` for the Eastern clock);
  - uses promises instead of `async`/`await`, which old browsers can't even read;
  - shows startup errors on screen (the red bar above);
  - calls the `webkit`-prefixed fullscreen functions when the standard ones are missing.

  When changing the TV page, avoid `async`/`await`, `?.`, `??`, `catch {` without a variable, `{...obj}` object spread, and newer built-in functions unless you add a fallback in that first script. To check, pull the main `<script>` out of the page and run `npx esbuild page.js --target=chrome51`: it should finish without errors.
- **Activity feed (Google Apps Script).** A Sheet-bound script pulls quote, order and delivery activity from Redash every 6 hours, adds the weather from OpenWeather, and serves it as public JSON with no emails in it. The TV turns it into speech bubbles and window weather.
- **Live control (Cloudflare Worker + Durable Object).** The relay in [relay/](relay/) is how the user page moves a character on the TV in real time:
  - A Durable Object is a single, stateful instance of code that Cloudflare runs somewhere close to its users. We use exactly one, named `office`, as a chat room that every page connects to.
  - Every TV holds a WebSocket to it and only listens. The user page connects with `?uid=<id>` and sends its steps, sits and look changes. The room passes each message on to everyone else.
  - Each look is saved in the Durable Object's built-in SQLite storage. A TV that connects later gets everyone's current look, plus who is driving right now and where they are standing.
  - When a user's socket closes, the room tells everyone `bye` and that character goes back to its routine.
  - It uses the WebSocket Hibernation API, so idle connections cost nothing and keep-alive pings are answered without waking the object. That keeps it on Cloudflare's free plan.
  - The Worker only accepts connections from `timberjones.github.io`, localhost and local files. It checks every message (ids, grid bounds, colours) and rate-limits each user.
  - To deploy: `cd relay && npx wrangler@4 deploy`.
- **Live headcount (optional).** [tools/office-headcount.ps1](tools/office-headcount.ps1) runs on a laptop in the office (7:00-10:00 and 15:00-16:30 every 30 min, and at logon, via `tools/install-headcount-task.ps1`). Only on a GoMaterials Wi-Fi, it counts laptops on the subnet by MAC vendor and posts the number to the relay's `POST /count` (Bearer `COUNT_TOKEN` secret). The relay keeps the morning peak and the lowest afternoon count (from 2 pm, with the time of the last one) and sends them to every TV. The TV uses them as today's headcount, and from the afternoon count it sends the product seat home and lets the rest leave one by one until 6 pm; with no count for today, the TV uses its usual weekday guess.
