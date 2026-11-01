# Conversation annotations

This drop-in adds file and message annotations to the conversation composer. It saves the selected text as a snapshot with its source, range, and comment. Sending the draft puts the snapshot in the message history, even if the file changes later. Multiple notes can be added before sending.

## Requirements

- A Pi Pocket build with the native `pocket.addAnnotation` composer API. Native `pocket.messageAction` and transcript text selection are needed to annotate both user messages and Pi replies. Older builds offer only the reply action and cannot add drafts without `addAnnotation`.
- The owner or a guest who can steer every session. Pi Pocket does not currently load extension clients or routes for people invited to a single session.
- Text files must be inside the conversation's workspace. The route rejects paths outside the workspace, symlink escapes, the active Pocket data directory, and the agent directory. Files must be valid UTF-8, contain no NUL bytes, and be at most 1 MiB.

## Install

Copy `conversation-annotations.ts` into the Pocket data folder's `extensions/` directory. Copy the adjacent `conversation-annotations/` folder beside it. Use the Extensions sheet to enable the module. If the data folder has no `extensions/node_modules` link, follow the Pocket drop-in documentation to provide its existing package dependencies. Do not install another copy of Pocket into the drop-in folder.

Select a file range through the composer button, or select transcript text and choose **Annotate selected text**, then **Annotate**. Review the snapshot and enter a comment. The composer keeps the draft until it is sent or removed. The module never sends a message itself.

## Undo

Disable the module in the Extensions sheet. Remove its drop-in file and browser folder only after the owner approves that removal. Messages already sent retain their snapshots. Unsent native composer drafts are separate local browser data; disabling the module does not remove them. Remove each draft from the composer if desired.
