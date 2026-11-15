# Team Collaboration — Domain Overview

Source: Team Collaboration - Business Requirements Specification v1.0 (POC excerpt)

## Roles

| Role  | How it is obtained                                        | Summary of permissions                          |
|-------|-----------------------------------------------------------|-------------------------------------------------|
| ADMIN | Registering and creating a **new team** (team founder)    | Manage discussions, view the user directory     |
| USER  | Registering and **joining an existing team**              | Read discussions, comment, manage own profile   |

## Glossary

- **Team** – a group of users. Every user belongs to exactly one team.
- **Discussion** – a titled topic within a team, created by an administrator.
- **Comment** – a reply on a discussion; any team member may comment.
- **User directory** – the list of users with their names, emails and roles.

## Notes for testers

- Each test must create its own team and users; no pre-provisioned accounts exist.
- Role is decided at registration time and cannot be changed through the UI.
