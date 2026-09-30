# Identity, sign-ins, and notifications

## Change the character

Open **Memory & preferences**, or open the character panel and choose **Identity → Edit name & look**. Enter an agent name, choose a color and an accessory, watch the animated preview, then choose **Save preferences**. The look follows the character around Work; it does not change the local model.

## Partner login

Under **Passwords, sign-ins & notifications**, choose **Manage partner login**. The owner can create, rotate, or remove a separate login through the Seek proxy. A partner opens the same Work workspace and can see its chats, tasks, files, finance, connections, and browser sessions. Changing or removing the login invalidates earlier partner sessions.

## Signed-in websites and Bitwarden

The shared browser keeps its own site sessions. **Signed-in sites** lists where it has been signed in. **Sign out** clears that site's browser cookies and storage; **Sign out of all sites** clears every saved browser session. This does not sign your ordinary Chrome profile out.

Bitwarden is optional. To offer saved logins during a browser handoff:

1. Install the Bitwarden CLI on the host PC and run `bw login` there once.
2. In **Memory & preferences → Password vault (Bitwarden)**, choose **Refresh**. Unlock the vault **on the host PC** with your master password and choose how long to keep it unlocked.
3. When a matching site asks for sign-in, review the offered login and approve that one fill. The agent receives neither your master password nor the saved password. Choose **Lock now** when finished.

Remote unlock is blocked. If you do not use Bitwarden, choose **Browser → Take over**, sign in yourself, then **Resume agent**. Keep credentials and one-time codes out of conversations.

## Browser action approvals

For a hard-to-undo browser click, **Needs you** offers **Approve once**, **For this task**, **Always on this site**, or **Reject**. Review the site, action label, and task before choosing a scope. The **Always-allowed actions** list in **Memory & preferences** lets you remove a standing site allowance later.

## Notifications

In **Memory & preferences → Notifications on this device**, choose **Turn on notifications** and allow the browser prompt. On supported browsers, task completion and request alerts can arrive even with the Work tab closed, while the host and harness are running. On iPhone, add Seek to the Home Screen first. Use **Send a test** to check the subscription and **Turn off here** to revoke it on this device. Some browsers also offer **Install Seek as an app**.

The push service receives a payload-free signal; the Work service worker fetches the notification details from your Seek server. In-app alerts remain available in **Needs you** and the task conversation.
