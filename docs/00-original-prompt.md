# Original prompt

> Saved verbatim on 2026-10-13 as the starting point for this project.

Most of my time, since a while ago and now even more, I spend reviewing code. And, despite all the AI agents revolution, code review hasn't changed. At the end of the day, we are still reading text files (beatifully colorized, with nice shortcuts and search systems, but still text files). However, reviewing code is not reviewing text. See this PR for example: https://github.com/marcelomendoncasoares/serverpod_offline_sync/pull/168. There are a lot of changes that I shouldn't need to review.

- Migrations: if I'm ok with the model changes, I don't even want to see the migration file's diff. A mention or description would do.
- Parameter rename from spaceId -> userId: if I approved changing the signature on the function, the diff from the entire code should disappear from my review (or allow me to peek the changes on usage places related to the change if I want). Same for adding userId to mergeInboundBatch.
- Generated code: Despite being able to mark as generated on gitattributes, they still show on the file list; the diff still counts; and I can't easily filter them from review on any tool.

Besides being able to ignore unimportant text changes that are blast radius of already seen code changes, I would also like to be able to mark code changes as reviewed. I currently use https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare to navigate through the code using LSP and PR-like diff, but I can only mark a file as viewed. And any changes to it will make the whole file un-viewed again, and I have to search for the part that is new.

How could we build a tool that solves these pains? Propose a UX and draft some throwaway visualizations for us to discuss.

Relevant references:
- https://github.com/Ataraxy-Labs/sem
- https://github.com/Ataraxy-Labs/inspect
- https://pub.dev/packages/dart_source_graph
- https://arxiv.org/abs/2609.32057

Save this prompt to a docs/ folder for future reference.
