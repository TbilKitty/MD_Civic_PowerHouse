# Maryland Legislative Watch

Maryland Legislative Watch is an independent civic-participation website that:

- downloads the Maryland General Assembly's official open legislative data;
- classifies bills under friendly public-interest categories;
- detects title, synopsis, hearing, committee, status, version, and passage changes;
- optionally generates source-bound plain-language AI summaries;
- lets residents create editable support, opposition, amendment, or informational letters;
- lets confirmed subscribers receive matching immediate, daily, or weekly email updates.

The public tracker is designed for GitHub Pages. The optional private subscription service uses a Cloudflare Worker, Cloudflare D1, and Resend. Subscriber email addresses never belong in this repository.

## What requires an API key?

| Feature | Key required? | Service |
| --- | --- | --- |
| Download official Maryland bills | No | Maryland General Assembly |
| Track changes every four hours | No | GitHub Actions |
| Display/search/filter bills | No | GitHub Pages |
| Generate and copy letters | No | Runs in the visitor's browser |
| AI-written summaries | Optional | OpenAI API |
| Store subscribers | Account/configuration, but no browser key | Cloudflare D1 |
| Send confirmation and update emails | Yes | Resend API |

Without an OpenAI key, the site uses Maryland's official synopsis. Without the subscription service, every other public feature continues to work.

## Repository map

```text
maryland-legislative-watch/
├── .github/workflows/
│   ├── pages.yml             Publish the site
│   ├── test.yml              Run tests
│   └── update.yml            Refresh bills every four hours
├── backend/
│   ├── migrations/           Private subscriber database schema
│   ├── worker.js             Subscription, confirmation, digest, unsubscribe
│   └── wrangler.jsonc        Cloudflare configuration
├── site/
│   ├── data/                 Generated public bill and change data
│   ├── app.js                Search, filters, form, and letter generator
│   ├── config.js             Public site configuration
│   ├── index.html            Homepage
│   ├── privacy.html          Privacy policy template
│   └── styles.css            Maryland-inspired design
├── tests/                    Python tests and fixture
├── config.json              Session and topic configuration
├── notify_subscribers.py    Secure event dispatch
└── update_data.py           MGA downloader, classifier, diff, and AI hook
```

## Fastest public-site setup

1. Unzip this project.
2. Create an empty public GitHub repository.
3. Upload **the contents of this folder** to the repository's `main` branch.
4. In GitHub, open **Settings → Pages**.
5. Under **Build and deployment**, choose **GitHub Actions**.
6. Open the repository's **Actions** tab.
7. Select **Update Maryland legislation**, choose **Run workflow**, and wait for it to finish.
8. Select **Publish website**, choose **Run workflow**, and wait for the deployment URL.

The first update creates a baseline and will not report thousands of existing bills as “new.” Later runs record actual differences.

## Test it on your computer

From the project directory:

```bash
python update_data.py
python -m unittest discover -s tests -v
python -m http.server 8000 --directory site
```

Then visit `http://localhost:8000`.

Do not open `site/index.html` directly as a file; browsers commonly block its JSON requests. Use the local server command above.

## Activate subscriptions

Subscriptions require a private backend because GitHub Pages is static and the repository is public.

### 1. Create the email sender

1. Create a Resend account.
2. Add and verify a sending domain.
3. Create a Resend API key.
4. Retain the key for the Cloudflare secret step. Do not put it in `site/config.js` or commit it.

### 2. Create the Cloudflare Worker and database

Install a current Node.js release, then run:

```bash
cd backend
npm install
npx wrangler login
npx wrangler d1 create maryland-legislative-watch --binding SUBSCRIBERS --update-config
npm run db:remote
```

Edit `backend/wrangler.jsonc`:

- replace `SITE_URL` with the full GitHub Pages project URL, without a trailing slash;
- replace `SITE_ORIGIN` with its origin, normally `https://YOUR-USERNAME.github.io`;
- replace `EMAIL_FROM` with the verified Resend sender;
- after the first deployment, replace `WORKER_URL` with the actual Worker URL and deploy again.

Create the two secrets:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put DISPATCH_TOKEN
npm run deploy
```

Use a long random value for `DISPATCH_TOKEN`. The exact same value must later be stored as a GitHub repository secret.

### 3. Connect the website

Edit `site/config.js` and place the deployed Worker URL in `subscriptionApiUrl`:

```javascript
window.MLW_CONFIG = {
  subscriptionApiUrl: "https://your-worker.your-subdomain.workers.dev",
  representativeFinderUrl: "https://mgaleg.maryland.gov/mgawebsite/Members/District",
  myMgaUrl: "https://mgaleg.maryland.gov/mgawebsite/MyMGATracking/WitnessSignup"
};
```

Commit the change.

### 4. Connect scheduled updates to the Worker

In **GitHub → Repository Settings → Secrets and variables → Actions**:

Create a repository **variable**:

- `SUBSCRIPTION_API_URL`: deployed Worker URL

Create a repository **secret**:

- `DISPATCH_TOKEN`: the exact Worker dispatch token

The four-hour workflow will then forward new legislative events. The Worker sends immediate alerts promptly, daily digests once per day, and weekly digests on Sunday.

## Optional AI summaries

Create a repository Actions secret named `OPENAI_API_KEY`. You may also create these Actions variables:

- `OPENAI_MODEL`: defaults to the model in `config.json`;
- `AI_MAX_PER_RUN`: defaults to 10 to control cost;
- `AI_TOPIC_ALLOWLIST`: comma-separated topic IDs, such as `criminal_justice,housing,tax_economic_policy`.

AI is intentionally rate-limited. A summary is generated again only when its source hash changes. Generated summaries disclose the model, time, source hash, and human-review status. Review summaries before representing them as authoritative.

## Automatic annual session rollover

`automatic_session_rollover` is enabled in `config.json`. Beginning in a new calendar year, each scheduled run probes that year's regular-session feed. It switches only after the MGA endpoint returns a nonempty list, so an unpublished or temporarily unavailable future feed does not erase the active session.

On the first successful 2027 run, the updater automatically:

1. archives the 2026 bills, changes, metadata, and AI summaries under `site/data/sessions/2026RS/`;
2. switches the current public dataset to `2027RS`;
3. adds 2026 to the website's session selector;
4. identifies 2027 proposals as new-bill events so existing interest subscriptions can match them;
5. continues four-hour monitoring without changing `config.json`.

The same process works for later regular sessions. Special sessions remain manual because their identifiers and relationship to the regular session require an editorial decision. To pin the website to the configured session, set `automatic_session_rollover` to `false`.

Never identify a bill solely by title. The tracker uses the session plus bill number, such as `2026RS:HB0001`.

## Before public launch

- Replace every bracketed placeholder in `site/privacy.html`.
- Provide a monitored project email address.
- Test confirmation and unsubscribe links using your own email.
- Test the letter generator on a phone and desktop.
- Confirm the representative-finder and MyMGA links.
- Review topic mappings in `config.json` for over- and under-inclusion.
- Add a domain-level privacy policy if your email or analytics provider requires it.
- Do not promise that an AI summary is legal advice or a substitute for official materials.

## Public positioning

General bill trackers already exist. This project is best described as a Maryland civic-participation and legislative-translation tool. Its distinctive purpose is to let residents choose real-life interests before they know bill numbers, see what materially changed, and move directly from an official-source explanation to Maryland-specific participation.

## Data and responsibility

The Maryland General Assembly remains the authoritative source. This project is independent and nonpartisan. Automated classifications and summaries can be incomplete or wrong; all bill cards link to the official record.
