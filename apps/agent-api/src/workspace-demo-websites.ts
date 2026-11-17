import type { BrowserCampaignTargetInput } from "./browser-credentials-repository";
export const demoWebsites: BrowserCampaignTargetInput[] = [
    {
        siteName: "WordPress Playground (isolated demo)",
        registrationUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
        publishUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
        articleTitle: "NPATI browser automation test",
        articleBody: "This draft verifies that the browser agent can create and publish an article in an isolated WordPress Playground session.",
        priority: 10,
        status: "paused",
    },
    {
        siteName: "RealWorld Conduit (public demo)",
        registrationUrl: "https://realworld.svelte.dev/register",
        publishUrl: "https://realworld.svelte.dev/editor",
        articleTitle: "NPATI browser automation test",
        articleBody: "A test article created by the NPATI browser automation in the public RealWorld demo application.",
        priority: 20,
        status: "paused",
    },
];
