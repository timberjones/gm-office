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
- `?water=1` sends the water delivery in right away (otherwise it comes at random, 8:30-16:30, not every day)
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

**Keys on the TV page:** N night, D day, C back to the real clock, W cycle the weather, B someone says a line now, F or Enter (remote OK) fullscreen. Clicking an empty spot also toggles fullscreen; clicking a person makes them say hi (click them more than 5 times in 10 seconds and they get angry: "STOP CLICKING ME", and they ignore clicks for 5 seconds).

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
  - **One office on every screen.** The first screen to connect (normally the TV) leads: it runs the office and, while anyone else is watching, sends a snapshot of everyone's position, pose and speech bubble 4 times a second. Every other screen draws those snapshots and glides people between them, so the TV, your computer and anyone else's all show the same thing. Clicking someone on a follower asks the leader, so everyone sees the same hello. If the leader closes or goes quiet for 3 seconds, another screen takes over from where things stand. Faces, chair colours and arrival times come from a fixed seed, so they match on every screen too. Without the relay, each screen simply runs its own office.
  - To deploy: `cd relay && npx wrangler@4 deploy`.
- **Live headcount (optional).** [tools/office-headcount.ps1](tools/office-headcount.ps1) runs on a laptop in the office (7:00-10:00 and 15:00-16:30 every 30 min, and at logon, via `tools/install-headcount-task.ps1`). Only on a GoMaterials Wi-Fi, it counts laptops on the subnet by MAC vendor and posts the number to the relay's `POST /count` (Bearer `COUNT_TOKEN` secret). The relay keeps the morning peak and the lowest afternoon count (from 2 pm, with the time of the last one) and sends them to every TV. The TV uses them as today's headcount, and from the afternoon count it sends the product seat home and lets the rest leave one by one until 6 pm; with no count for today, the TV uses its usual weekday guess.

## Under the hood (for the tech geeks)

### Cloudflare Durable Objects: WebSockets without a server

Live features (driving your character, syncing screens, the headcount) need something that holds open connections and keeps a little state. A normal serverless function can't: each request runs separately and forgets everything. A **Durable Object** is the in-between. It's a single JavaScript object with a name, its own memory and its own SQLite storage, and Cloudflare makes sure only one copy exists anywhere.

- The Worker sends every connection to one object named `office`, so every TV, phone and laptop talks to the same place. Broadcasting is just a loop over its open sockets.
- **Hibernation** keeps it free: when nothing is being sent, Cloudflare unloads the object but keeps the sockets open. Keep-alive pings get an automatic `pong` without waking it.
- Looks (`look:<uid>`) and today's headcount (`count`) go in its built-in storage. The latest sync snapshot stays in memory only, since it's only useful for a few seconds.
- No servers, no database to run, no open ports, and the whole relay is about 200 lines ([relay/src/index.js](relay/src/index.js)).

### Weather: the windows match the sky outside

- The Apps Script feed asks OpenWeather for Montreal's current conditions, caches the answer for 15 minutes, and reduces it to one word: `sun`, `cloud`, `rain` or `snow`. The API key lives in the script's properties, never in the page.
- The TV checks the feed every 15 minutes (retrying faster if it boots offline). Rain and snow fall past the windows and over the alley, snow whitens the ground, and clouds drift shadows across the parking lot.
- Daylight follows Montreal's real sunrise and sunset for the month, on Eastern time, so the office darkens and the alley lamps come on at the right hour.

### Leader and followers: one office on every screen

Every screen runs the same simulation code, and the simulation is random: who gets up for coffee, who talks, which way someone walks. Left alone, two screens drift apart within seconds. Instead of trying to keep two random simulations in step, only one screen simulates at a time.

- **Election:** the first screen to connect with `?sync=1` (every current page does) is the leader. The relay tracks the role in each socket's attachment, so it survives hibernation.
- **Snapshots:** while at least one other screen is watching, the leader sends about 2 KB of JSON 4 times a second. That covers each person's position, pose, seat and speech bubble, plus the dogs, the courier and the roomba. With nobody else watching it sends nothing.
- **Followers** don't simulate. They glide each person toward the latest snapshot over 250 ms. Seats are sent as indexes into the shared seat list, and hallway positions are rescaled because each screen's width differs. Speech text is only shown if it's a line the page already knows, so a forged snapshot can't put words on the TV.
- **Clicks** on a follower go to the leader as a `poke`. The leader picks the line, and it comes back to everyone in the next snapshot.
- **Failover:** a follower that hears nothing for 3 s sends `claim`. The relay agrees only if it hasn't heard from the leader either. The new leader restarts everyone's routine from where they stand. If the leader's socket closes, the relay promotes the next screen right away.
- **Version check:** snapshots carry the seat and worker counts, so a TV still running an old page ignores them instead of drawing nonsense.
- **When nobody is watching** (say, the TV off overnight), nothing runs anywhere, and nothing needs to. Who's in is worked out from the date and time, so the next screen to open rebuilds the office as it should be at that moment. Faces, chair colours and arrival times come from a fixed seed, so they're identical on every screen.

### Seat count: a real headcount, with a fallback

- [tools/office-headcount.ps1](tools/office-headcount.ps1) runs on one laptop: 7:00-10:00 and 15:00-16:30 every 30 minutes, and at logon. It only runs on a GoMaterials Wi-Fi.
- **How it counts:**
  - It pings every address on the subnet, slowly. Firewalled laptops ignore the ping but still answer ARP, so they still land in Windows' neighbour table.
  - It reads that table and identifies each device's maker from the first half of its MAC address, using Wireshark's public manufacturer list (cached locally, refreshed at most weekly).
  - It counts only laptops: PC Wi-Fi chip makers (Intel, AzureWave, Liteon, Realtek, Foxconn/Fugui...) and Apple devices with a fixed address.
  - It skips randomized MACs (phones), smart-home devices, printers and network gear. It's anonymous: only a number leaves the laptop.
- The number goes to the relay's `POST /count` with a secret token. Before 2 pm the relay keeps the day's highest number. From 2 pm on it keeps the lowest number and the time it was sent: when the laptop's owner leaves, the TV sends them home and lets the rest leave one by one until 6 pm.
- **Fallback:** a count only applies to the day it was sent. With no count for today (laptop owner away, laptop asleep, script failed, relay down), the TV uses its usual weekday guess: Tue/Thu 80-95% of desks, Mon/Wed/Fri 10-30%. The office never depends on the script.
- First real check (2026-10-06): the script said 19 with 20 people in.

### Engineering notes

- **Every live part is optional.** The activity feed, live weather, relay, headcount and screen syncing each fail quietly to a working default:
  - no relay: each screen runs its own office;
  - no feed: people just don't speak, and the windows show plain sun;
  - no headcount for today: the weekday guess.

  No single outage leaves the TV blank, and the page still runs from a local file with everything turned off.
- **Built to run forever on free tiers.** The whole thing is designed to stay at $0 so nobody ever has to pay for it or turn it off:
  - GitHub Pages hosts the site, Apps Script serves the feed, and the relay stays on Cloudflare's free plan.
  - Idle connections cost nothing (WebSocket hibernation), and the leader only sends snapshots while someone else is watching.
  - The feed caches Redash data for 6 hours and weather for 15 minutes, and the vendor list is downloaded at most once a week.
- **Data privacy by design.** Only what the office needs leaves anyone's machine, and no names or emails appear anywhere:
  - The headcount sends a single number. Device addresses and names never leave the laptop, and devices are never matched to people.
  - The headcount endpoint needs a secret token, kept in a git-ignored file on the laptop and as a Cloudflare secret.
  - Personalities and speech are mapped by user id to a seat, the same way. The public feed carries ids and work numbers, never who the person is.
  - API keys live in Apps Script properties and Cloudflare secrets, not in the page.
- **No dependencies.** The pages are plain HTML, canvas and JavaScript, with no npm packages, framework, bundler or build step. The relay is one ~200-line Worker using only Cloudflare's own APIs. There's nothing to upgrade or patch, and nothing that can break when a library changes.
