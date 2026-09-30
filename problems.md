# Data persistence and retrieval review

This file records the original code-level findings and their follow-up status. The findings below describe the issues as they existed during the initial review; they are not a list of currently open bugs. Production database contents and deployed behavior were not independently inspected.

## Resolution status

| Finding | Status and fix |
| --- | --- |
| 1–2. Task deletion and editing | Resolved. Added teacher-owned task update/delete endpoints, synchronized student task copies, and clean up task-related grades and notifications. The dashboard now waits for API responses and surfaces failures. |
| 3. Quiz/task assignment persistence | Resolved. Quiz and task creation now uses the API; assignment failures are returned as errors and task creation is rolled back. |
| 4. Marks and class grades | Resolved. Marks load from and save to the API; class-view grading persists through the task-grade endpoint and updates student-facing grade/task data. |
| 5. Manual student profile edits | Resolved. Teacher edits use a teacher-owned student endpoint, while student self-service profile updates are student-role-only. |
| 6. Stale browser task data | Resolved. Teacher tasks now load from the server and local task storage is no longer used as their source of truth. |
| 7. Student profile fields on reload | Resolved. Profile retrieval includes persisted fields, and name changes also update Auth metadata. |
| 8. Notification read state | Resolved. The UI checks the response before changing its local read state. |
| 9. Registered-student retrieval | Resolved. Auth pagination is handled and Auth API errors are surfaced. |
| 10. Classes shared across teachers | Resolved. Class reads are scoped to the authenticated teacher in the Express and Edge Function implementations. |
| 11–12. Student summary requests | Resolved. Batch request/response shapes are compatible, and student summary requests use the authenticated access token. |
| 13. Settings persistence | Resolved. Profile, preference, notification, password, deactivation, and deletion actions now call their respective APIs/Auth operations. |
| 14. Hidden save failures | Resolved. Student/class autosaves and task/grade operations check HTTP failures and notify the user. Autosave is gated until initial server data has loaded successfully. |
| 15. Partial task assignment failures | Resolved for task creation. Assignment errors are surfaced and the task record is rolled back; multi-key Supabase KV updates are still not transactional. |

## Remaining limitations

- Supabase KV writes spanning multiple keys are not transactional. A database/network failure during a multi-record update can still leave related records temporarily inconsistent; handlers surface the error and some flows attempt rollback.
- No live Supabase integration tests were run, so deployed credentials, RLS configuration, and production data behavior still need environment-level verification.

## Original findings

The following sections preserve the details of the initial audit for traceability.

## High impact

### 1. Deleting a task only removes it from the current React state

**Affected flow:** Teacher → Tasks & Quizzes → delete.

- `client/src/components/AdminDashboard.tsx:370-374` filters the task out of `tasks` and shows a success toast, but does not call an API.
- There is no delete-task route in `server/routes/teacher.js:8-26`.
- The persisted `tasks:<teacher-id>` record is therefore unchanged. Student assignment records (`student_tasks:<email>`) and grade records are also left untouched.
- Reloading can bring the task back from the database. Students can continue seeing their assigned copy, and reports can still include its grades.

### 2. Editing a task does not persist, and the shared task-save request is incompatible with the API

**Affected flow:** Teacher edits a task; quiz creation also uses this save path.

- `client/src/components/AdminDashboard.tsx:362-366` updates the screen state and calls `saveTasks` with a list of tasks.
- `client/src/components/AdminDashboard.tsx:192-201` sends that list as `{ tasks }` to `POST /teacher/tasks`.
- `server/routes/teacher.js:12` routes that endpoint to `createTask`, and `server/controllers/teacherController.js:66-70` expects one task object with a `title`, not a `{ tasks: [...] }` payload. This request is rejected with HTTP 400, so the database is not updated.
- `saveTasks` does not check `response.ok`, and the edit handler shows “updated successfully” without waiting for or checking the save. Thus the failure is easy to miss.

### 3. New quizzes and their student assignments are saved only in browser storage

**Affected flow:** Teacher → class → create quiz.

- `client/src/components/AddQuiz.tsx:116-128` adds the quiz to each student's `student_tasks:<email>` key in `localStorage`.
- It then calls `onAddQuiz` at line 133. The parent handler in `AdminDashboard.tsx:348-352` invokes the incompatible `saveTasks` request described above.
- The student API reads assignments from Supabase (`server/controllers/studentController.js:36-46`), not from browser storage. As a result, the quiz can appear created in the teacher's current browser while not being persisted for students or other devices.

### 4. Marks Management grades are effectively browser-only

**Affected flow:** Teacher → Marks Management → add/edit grade.

- `client/src/components/MarksManagement.tsx:73-77` loads the grade list only from `localStorage`; it does not load `data.grades` from the teacher API.
- Add/edit operations only update React state (`:127-168`). The effect writes that state back to local storage (`:81-87`).
- The attempted backend sync at `:91-104` sends `{ grades }` to `POST /teacher/grades`. But `server/controllers/teacherController.js:211-215` expects the fields `taskId`, `studentEmail`, and `grade` at the top level, and rejects this array payload. The client merely logs a sync error.
- Grades entered through the Class View are also only written to `localStorage` (`client/src/components/ClassView.tsx:343-372`); that handler does not call either grading API.
- Consequently, grades can disappear on another browser and won't be reliably available to the student dashboard or database-backed reports.

### 5. Editing a manually added student's profile writes to the teacher's profile key

**Affected flow:** Teacher → Students → select a non-registered/manual student → profile.

- `client/src/components/AdminDashboard.tsx:536-545` opens `StudentProfile` for a selected non-registered student, passing the teacher's `accessToken`.
- `client/src/components/StudentProfile.tsx:53-72` posts the displayed student's form to `/student/profile/update`.
- The student update handler (`server/controllers/studentController.js:89-94`) ignores the selected student identity and writes to `student_profile:${user.email}`, where `user` comes from the request's authenticated token.
- In this flow, that token belongs to the teacher, so the save can write the manual student's form values under the teacher's email. It does not persist the selected student's profile. The endpoint also lacks an explicit student-role check.

## Medium impact

### 6. Existing browser task data takes precedence over database task data

**Affected flow:** Teacher dashboard initialization.

- `client/src/components/AdminDashboard.tsx:88-96` loads `dental_college_tasks` from local storage first.
- At `:114-116`, server tasks are loaded only when that browser key is absent. A stale key can therefore hide newer database tasks.
- This compounds the task-save failure: edits/creates can look right in the current browser even though the database remains unchanged.

### 7. Several student profile edits are stored but not returned on reload

**Affected flow:** Student → My Profile.

- `client/src/components/StudentProfile.tsx:53-72` posts the form's full profile data to the student profile update endpoint.
- `server/controllers/studentController.js:89-94` merges the data into the Supabase key/value profile, but `getProfile` (`:8-28`) only returns a limited set of profile fields. Fields such as phone, department, specialization, qualification, join date, address, and bio are not returned to initialize the form again.
- The displayed name is selected from Supabase Auth metadata at `server/controllers/studentController.js:9`, not from the edited key/value profile. The profile update endpoint does not update Auth metadata, so changing the name can appear successful and then revert after reload.
- The form also permits editing email, but the API forcibly stores `email: user.email` (`:91-93`); it does not change the authenticated account email.

### 8. Student notifications can appear marked read even when the database update fails

**Affected flow:** Student notification list.

- `client/src/components/StudentDashboard.tsx:281-296` awaits the mark-read request but does not check `response.ok`.
- It then marks the notification read in local React state and decrements the unread count regardless of an HTTP error response.
- If the API rejects the request or returns an error, the notification can appear read until reload, while Supabase still says it is unread.

### 9. Registered-student lookup can turn an Auth API error into a successful empty roster

**Affected flow:** Teacher → registered students.

- `server/controllers/teacherController.js:251-252` calls `supabase.auth.admin.listUsers()` but ignores its `error` field.
- If Supabase Auth returns an error, `authData?.users` evaluates empty and the controller continues returning a normal students response.
- The frontend can then display an empty registered-student list instead of surfacing that retrieval failed.
- `listUsers()` is called without pagination (`:251`), so projects with more users than the API's default page size can silently omit students beyond the first page.

## Additional findings from the second pass

### 10. Teacher dashboards merge class records across teachers and can pick the wrong version

**Affected flow:** Teacher dashboard class list.

- `server/controllers/teacherController.js:28-35` reads every `classes:*` record, then combines the entries into the response instead of reading only `classes:${user.id}`.
- The alternate Edge Function implementation repeats the same all-teachers query at `client/src/supabase/functions/server/index.tsx:126-137`.
- The Edge Function explicitly describes classes as shared, so cross-teacher visibility may be intentional. However, each teacher writes a separate class record, and the read merges these records by ID. Because classes are created with shared/static IDs (`client/src/components/AddClass.tsx:33-41`), a matching ID overwrites another teacher's version in the map; the returned capacity/student count and other stored fields can come from whichever record is read last.

### 11. Registered-student batch stats use a request and response shape the API does not support

**Affected flow:** Teacher → Portal Students roster.

- `client/src/components/RegisteredStudentsList.tsx:42-52` posts `{ studentEmails }` to `/teacher/students-batch-data`.
- `server/controllers/teacherController.js:398-409` expects `{ emails }`; it returns HTTP 400 for the client's payload. Even if the request key were corrected, it responds with `{ students: { [email]: { streak, taskCount, completedCount, grades } } }`, while the frontend reads `result.studentsData[email].streakData` and `.taskData` (`RegisteredStudentsList.tsx:57-64`).
- The frontend falls back to the unenhanced roster, so registered students' streak and task totals are absent/defaulted rather than retrieved from the database.

### 12. Student summary requests use an access-token key this code never populates

**Affected flow:** Teacher → Students list (not the Portal Students list).

- `client/src/components/StudentsList.tsx:34-36` reads `localStorage.getItem('access_token')` and skips the streak/task API requests if no value exists.
- Authentication in `client/src/App.tsx` keeps the token in React state and sends it directly in request headers (`:54`, `:117`); no code in `client/src` writes an `access_token` local-storage entry.
- Consequently, in the normal app login flow this list falls back to the unenhanced students and does not retrieve the corresponding database-backed summaries.

### 13. Settings reports saved results for values that are not persisted

**Affected flow:** Teacher → Settings.

- Notification preferences and general preferences only update component state; their save handlers (`client/src/components/Settings.tsx:86-92`) show success without writing to an API or persistent storage.
- Password change (`:94-106`) only checks that the two new-password fields match and meet a length threshold, then shows success and clears the fields. It does not call Supabase Auth, check the current password, or change the account password.
- Deactivate and Delete buttons (`:645-670`) have no action handlers.
- These controls therefore report success or appear available without changing the corresponding account data.

### 14. Student, class, and task save helpers can hide HTTP failures

**Affected flow:** Teacher dashboard autosave.

- `client/src/components/AdminDashboard.tsx:162-205` awaits the `fetch` calls in `saveStudents`, `saveClasses`, and `saveTasks` but never checks `response.ok`.
- A server-side 400/401/500 response is not a rejected fetch, so these helpers can finish without reporting an error. The UI can retain the changed state while the database write failed.
- Task saves also have the payload/route mismatch described in finding 2; this finding additionally applies to student and class saves when the API rejects or authentication has expired.

### 15. Task creation may report success after assignment writes fail

**Affected flow:** Server-side task/quest creation and student assignment.

- `server/controllers/teacherController.js:95-118` (`createTask`) and `:154-180` (`addTask`) write the teacher's task record first, then catch student-assignment errors, log them, and still return a successful response.
- The task can therefore exist in the teacher's database while some or all `student_tasks:*` records and notifications were not written. The client treats the overall request as success, so the teacher is not told that assignment failed or was partial.

## Notes on related paths

- The regular daily-task form (`client/src/components/AddDailyTask.tsx`) posts to `/teacher/add-task`, which is routed to a separate handler that writes the task and student assignments to Supabase. This path differs from quiz creation and the generic task save helper.
- The `AddTask` and `QuestDialog` components also contain local-storage-only task assignment code (`client/src/components/AddTask.tsx:55-67`, `client/src/components/QuestDialog.tsx:71-86`), but they are not mounted by `AdminDashboard` in the inspected code. If those components are wired into the UI later, their assignment behavior will have the same cross-device persistence problem as quiz creation.
