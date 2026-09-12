# Start Here

The project is already populated with the official 2026 Maryland legislative dataset.

## To put the public tracker online tonight

1. Create a new public repository on GitHub.
2. Unzip the project.
3. Upload everything **inside** the `maryland-legislative-watch` folder to the new repository.
4. Commit the uploaded files to the `main` branch.
5. Open the repository's **Settings**.
6. Choose **Pages** in the left menu.
7. Under **Build and deployment**, select **GitHub Actions**.
8. Open the repository's **Actions** tab.
9. Run **Publish website**.
10. GitHub will display the website address when deployment finishes.

The tracker, search tools, Maryland design, bill data, and letter generator will work immediately.

The scheduled updater is configured to detect the next year's regular-session feed automatically. When the 2027 feed becomes available, it will archive 2026, switch the current tracker to 2027, and retain 2026 in a session selector.

## What will not work until separately activated

The email subscription form needs the private email backend described in `README.md`. Until then, it safely tells visitors that subscriptions are awaiting activation.

AI summaries are also optional. Without an OpenAI API key, the site shows the official Maryland synopsis.

## Files you will eventually personalize

- `site/privacy.html`: replace the bracketed contact and provider information.
- `site/config.js`: add the subscription Worker address after deployment.
- `backend/wrangler.jsonc`: add your GitHub Pages URL, Worker URL, verified sender, and D1 database ID.
- `config.json`: change the project name, session, topic descriptions, or AI limits.

For the complete subscription, email, AI, and annual-session instructions, open `README.md`.
