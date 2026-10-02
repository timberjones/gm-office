# GM Office

Pixel-art idle screen of the office for the office TV: the team works, takes calls, grabs coffee, holds meetings and eats lunch on Eastern time, with live weather in the windows.

Open `gm-office.html` (or the site root) full screen. Press F for fullscreen.

Useful URL options: `?time=14:30` (start the clock at a time), `?day=tue` (preview a weekday), `?weather=snow`, `?people=20`, `?dogs=1`. The full list is at the top of `gm-office.html`.

Drive your own character: open `gm-office.html?user=<your user id>` (e.g. `?user=2372`). Arrows / WASD walk, Space sits or stands. Your moves show live on the office TV through the relay in `relay/` (a Cloudflare Worker: `cd relay && npx wrangler@4 deploy`). Close the tab and your character goes back to its routine.
