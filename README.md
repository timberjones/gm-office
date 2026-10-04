# GM Office

Pixel-art idle screen of the office for the office TV: the team works, takes calls, grabs coffee, holds meetings and eats lunch on Eastern time, with live weather in the windows.

Open `gm-office.html` (or the site root) full screen. Press F for fullscreen.

Useful URL options: `?time=14:30` (start the clock at a time), `?day=tue` (preview a weekday), `?weather=snow`, `?people=20`, `?dogs=1`. The full list is at the top of `gm-office.html`.

Walk your own character around the TV: open `gm-user.html`, type your user id (or `1111` / "I'm new here" to come in as someone new), then use the arrow keys or the on-screen d-pad (tap = one step, hold = keep walking) and the Sit button. You can also change hair, skin, cap, beard, height and clothes; looks are saved and show on the TV. Moves and looks go through the relay in `relay/` (a Cloudflare Worker: `cd relay && npx wrangler@4 deploy`). Close the page and your character goes back to its routine, or walks out if it isn't in today. `gm-user.html` loads the people sprites and office layout from `gm-office.html` (the code between its `@shared` markers).

Secret: over lunch only (12-1 pm Eastern), the white storage cabinet on the right wall (under the two-seat desk) turns into a small QR code that opens the player page (via the short link `u.html`): scan it from about 10-30 cm. Preview it with `?time=12:30`.
