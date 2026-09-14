---
name: mixpanel-headless-setup
description: This skill installs mixpanel_headless, pandas, numpy, matplotlib, seaborn, networkx, anytree, scipy (and pyarrow on Python 3.11+), then verifies Mixpanel credentials. It should be invoked when setting up a new environment for Mixpanel data analysis, when dependencies are missing, or when configuring service account or OAuth credentials for the first time.
---

# Mixpanel Headless: mixpanel-headless-setup

This skill installs mixpanel_headless, pandas, numpy, matplotlib, seaborn, networkx, anytree, scipy (and pyarrow on Python 3.11+), then verifies Mixpanel credentials. It should be invoked when setting up a new environment for Mixpanel data analysis, when dependencies are missing, or when configuring service account or OAuth credentials for the first time.

If this workflow requires an account-backed connector, use the installed app/connector for Mixpanel Headless. If authorization is missing, ask the user to connect Mixpanel Headless before taking account actions.
