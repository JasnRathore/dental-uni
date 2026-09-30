const { kvGet, kvSet, kvDelete, kvGetByPrefix, getSupabaseClient } = require('../../database/services/dbService');
const { trackStudentActivity } = require('../services/studentService');

const runWithConcurrency = async (items, concurrency, operation) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], index);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
};

const getProfile = async (req, res) => {
  try {
    const user = req.user;
    const role = user.user_metadata?.role;
    if (role === 'student') return res.status(403).json({ error: 'Access denied. Not a teacher account.' });
    const name = user.user_metadata?.name || user.email?.split('@')[0] || 'Teacher';
    return res.json({
      teacher: {
        ...user.user_metadata,
        id: user.id,
        name,
        email: user.email,
        avatar: name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
        role: 'teacher',
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getData = async (req, res) => {
  try {
    const user = req.user;
    const [students, classes, tasks, grades] = await Promise.all([
      kvGet(`students:${user.id}`),
      kvGet(`classes:${user.id}`),
      kvGet(`tasks:${user.id}`),
      kvGet(`dental_college_grades:${user.id}`),
    ]);
    return res.json({
      students: students || [],
      classes: classes || [],
      tasks: tasks || [],
      grades: grades || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const saveStudents = async (req, res) => {
  try {
    const user = req.user;
    const { students } = req.body;
    if (!Array.isArray(students)) return res.status(400).json({ error: 'students array is required' });
    await kvSet(`students:${user.id}`, students);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const saveClasses = async (req, res) => {
  try {
    const user = req.user;
    const { classes } = req.body;
    if (!Array.isArray(classes)) return res.status(400).json({ error: 'classes array is required' });
    await kvSet(`classes:${user.id}`, classes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deleteClass = async (req, res) => {
  try {
    const user = req.user;
    const students = (await kvGet(`students:${user.id}`)) || [];
    if (Array.isArray(students) && students.some(student => student.classId === req.params.classId)) {
      return res.status(409).json({ error: 'Cannot delete a class while students are assigned to it' });
    }
    const classesKey = `classes:${user.id}`;
    const classes = (await kvGet(classesKey)) || [];
    const classList = Array.isArray(classes) ? classes : [];
    if (!classList.some(item => item.id === req.params.classId)) {
      return res.status(404).json({ error: 'Class not found' });
    }
    await kvSet(classesKey, classList.filter(item => item.id !== req.params.classId));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const updateManualStudent = async (req, res) => {
  try {
    const studentsKey = `students:${req.user.id}`;
    const saved = (await kvGet(studentsKey)) || [];
    const students = Array.isArray(saved) ? saved : [];
    const index = students.findIndex(student => String(student.id) === req.params.studentId);
    if (index < 0) return res.status(404).json({ error: 'Student not found' });
    if (students[index].isRegistered) return res.status(403).json({ error: 'Registered student profiles must be updated by that student' });

    const allowedFields = [
      'name', 'username', 'rollNumber', 'batch', 'classId', 'className', 'phone',
      'department', 'semester', 'specialization', 'qualification', 'joinDate', 'address', 'bio',
    ];
    const updates = Object.fromEntries(
      allowedFields.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]])
    );
    const student = { ...students[index], ...updates, id: students[index].id, email: students[index].email };
    students[index] = student;
    await kvSet(studentsKey, students);
    return res.json({ success: true, student });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const createTask = async (req, res) => {
  try {
    const user = req.user;
    const task = req.body;
    if (!task?.title?.trim()) return res.status(400).json({ error: 'Title is required' });
    const newTask = {
      id: task.id || `task-${Date.now()}`,
      title: task.title,
      description: task.description || '',
      maxPoints: task.maxPoints || task.points || 100,
      points: task.points || task.maxPoints || 100,
      dueDate: task.dueDate || task.date || new Date().toISOString().split('T')[0],
      date: task.date || task.dueDate || new Date().toISOString().split('T')[0],
      classId: task.classId || null,
      className: task.className || null,
      subject: task.subject || 'General',
      priority: task.priority || 'Medium',
      type: task.type || 'task',
      status: task.status || 'active',
      createdAt: new Date().toISOString(),
      teacherId: user.id,
      ...(task.type === 'quiz' ? {
        duration: task.duration,
        totalPoints: task.totalPoints,
        questions: task.questions || [],
      } : {}),
    };
    const tasksKey = `tasks:${user.id}`;
    const existingTasks = (await kvGet(tasksKey)) || [];
    const tasksList = Array.isArray(existingTasks) ? existingTasks : [];
    tasksList.push(newTask);
    await kvSet(tasksKey, tasksList);
    let assignedCount;
    try {
      assignedCount = await assignTaskToStudents(user.id, newTask);
    } catch (error) {
      await kvSet(tasksKey, tasksList.filter(item => item.id !== newTask.id));
      throw error;
    }
    return res.json({ ...newTask, assignedCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const addTask = async (req, res) => {
  try {
    const user = req.user;
    const { title, description, points, date, class_id, type, subject, priority } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    const task = {
      id: `task-${Date.now()}`,
      title: title.trim(),
      description: description || '',
      points: points || 50,
      maxPoints: points || 50,
      type: type || 'task',
      date: date || new Date().toISOString().split('T')[0],
      dueDate: date || new Date().toISOString().split('T')[0],
      classId: class_id || null,
      subject: subject || 'General',
      priority: priority || 'Medium',
      teacherId: user.id,
      createdAt: new Date().toISOString(),
      status: 'active',
    };
    const tasksKey = `tasks:${user.id}`;
    const tasks = (await kvGet(tasksKey)) || [];
    const tasksList = Array.isArray(tasks) ? tasks : [];
    tasksList.push(task);
    await kvSet(tasksKey, tasksList);
    let assignmentCount;
    try {
      assignmentCount = await assignTaskToStudents(user.id, task);
    } catch (error) {
      await kvSet(tasksKey, tasksList.filter(item => item.id !== task.id));
      throw error;
    }
    return res.json({ success: true, task, assignedCount: assignmentCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function assignTaskToStudents(teacherId, task) {
  const emailsToAssign = new Set();
  const allStudentsRaw = (await kvGet(`students:${teacherId}`)) || [];
  const allStudents = Array.isArray(allStudentsRaw) ? allStudentsRaw : [];
  const classStudents = task.classId
    ? allStudents.filter(student => student?.classId === task.classId && student.email)
    : allStudents.filter(student => student?.email);
  classStudents.forEach(student => emailsToAssign.add(student.email));

  const changedKeys = [];
  try {
    for (const email of emailsToAssign) {
      const key = `student_tasks:${email}`;
      const existing = (await kvGet(key)) || [];
      const list = Array.isArray(existing) ? existing : [];
      if (list.some(existingTask => existingTask.id === task.id)) continue;
      list.push({ ...task, completed: false, grade: null });
      await kvSet(key, list);
      changedKeys.push(key);

      const notifKey = `notifications:${email}`;
      const notifications = (await kvGet(notifKey)) || [];
      const notificationList = Array.isArray(notifications) ? notifications : [];
      notificationList.push({
        id: `notif-${Date.now()}-${Math.random()}`,
        type: 'task',
        title: 'New Assignment',
        message: `You have been assigned: ${task.title}`,
        createdAt: new Date().toISOString(),
        read: false,
        taskId: task.id,
      });
      await kvSet(notifKey, notificationList);
      changedKeys.push(notifKey);
    }
    return emailsToAssign.size;
  } catch (error) {
    for (const key of changedKeys) {
      const value = await kvGet(key);
      if (!Array.isArray(value)) continue;
      const filtered = key.startsWith('student_tasks:')
        ? value.filter(item => item.id !== task.id)
        : value.filter(item => item.taskId !== task.id);
      await kvSet(key, filtered);
    }
    throw error;
  }
}

const updateTask = async (req, res) => {
  try {
    const user = req.user;
    const tasksKey = `tasks:${user.id}`;
    const tasks = (await kvGet(tasksKey)) || [];
    const taskList = Array.isArray(tasks) ? tasks : [];
    const index = taskList.findIndex(task => task.id === req.params.taskId);
    if (index < 0) return res.status(404).json({ error: 'Task not found' });

    const updates = req.body || {};
    if (updates.title !== undefined && !updates.title?.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const previousTask = taskList[index];
    const updatedTask = { ...previousTask, ...updates, id: previousTask.id, teacherId: user.id };
    taskList[index] = updatedTask;
    try {
      const teacherStudents = (await kvGet(`students:${user.id}`)) || [];
      const eligibleEmails = new Set(
        (Array.isArray(teacherStudents) ? teacherStudents : [])
          .filter(student => student?.email && (!updatedTask.classId || student.classId === updatedTask.classId))
          .map(student => student.email)
      );
      const studentTaskEntries = await kvGetByPrefix('student_tasks:');
      for (const entry of studentTaskEntries) {
        if (!Array.isArray(entry.value)) continue;
        const email = entry.key.slice('student_tasks:'.length);
        let changed = false;
        const updatedStudentTasks = entry.value.flatMap(studentTask => {
          if (studentTask.id !== updatedTask.id) return [studentTask];
          changed = true;
          if (!eligibleEmails.has(email)) return [];
          return [{
            ...studentTask,
            ...updatedTask,
            completed: studentTask.completed,
            grade: studentTask.grade,
          }];
        });
        if (changed) await kvSet(entry.key, updatedStudentTasks);
      }
      await assignTaskToStudents(user.id, updatedTask);
      await kvSet(tasksKey, taskList);
    } catch (error) {
      taskList[index] = previousTask;
      await kvSet(tasksKey, taskList);
      throw error;
    }

    return res.json({ task: updatedTask });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deleteTask = async (req, res) => {
  try {
    const user = req.user;
    const tasksKey = `tasks:${user.id}`;
    const tasks = (await kvGet(tasksKey)) || [];
    const taskList = Array.isArray(tasks) ? tasks : [];
    const task = taskList.find(item => item.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const [studentTaskEntries, studentGradeEntries, notificationEntries, teacherGrades] = await Promise.all([
      kvGetByPrefix('student_tasks:'),
      kvGetByPrefix('student_grades:'),
      kvGetByPrefix('notifications:'),
      kvGet(`dental_college_grades:${user.id}`),
    ]);
    const updates = [];
    for (const entry of studentTaskEntries) {
      if (!Array.isArray(entry.value)) continue;
      const filtered = entry.value.filter(item => item.id !== task.id);
      if (filtered.length !== entry.value.length) updates.push(() => kvSet(entry.key, filtered));
    }
    for (const entry of studentGradeEntries) {
      if (!Array.isArray(entry.value)) continue;
      const grades = entry.value.filter(grade => grade.taskId !== task.id && grade.task_id !== task.id);
      if (grades.length !== entry.value.length) updates.push(() => kvSet(entry.key, grades));
    }
    for (const entry of notificationEntries) {
      if (!Array.isArray(entry.value)) continue;
      const notifications = entry.value.filter(item => item.taskId !== task.id);
      if (notifications.length !== entry.value.length) updates.push(() => kvSet(entry.key, notifications));
    }

    if (Array.isArray(teacherGrades)) {
      const filtered = teacherGrades.filter(grade => grade.taskId !== task.id && grade.task_id !== task.id);
      if (filtered.length !== teacherGrades.length) {
        updates.push(() => kvSet(`dental_college_grades:${user.id}`, filtered));
      }
    }

    await runWithConcurrency(updates, 20, update => update());
    await Promise.all([
      kvDelete(`task_grades:${task.id}`),
      kvSet(tasksKey, taskList.filter(item => item.id !== task.id)),
    ]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getTaskStudents = async (req, res) => {
  try {
    const user = req.user;
    const { taskId } = req.body;
    const allStudentsRaw = (await kvGet(`students:${user.id}`)) || [];
    const allStudents = Array.isArray(allStudentsRaw) ? allStudentsRaw : [];
    const tasks = (await kvGet(`tasks:${user.id}`)) || [];
    const task = Array.isArray(tasks) ? tasks.find(t => t.id === taskId) : null;
    const relevantStudents = task?.classId ? allStudents.filter(s => s.classId === task.classId) : allStudents;
    const taskGrades = (await kvGet(`task_grades:${taskId}`)) || {};
    const studentsWithGrades = relevantStudents.map(s => ({ id: s.id, name: s.name, email: s.email, avatar: s.avatar, classId: s.classId, className: s.className, grade: taskGrades[s.email] || null }));
    return res.json({ students: studentsWithGrades });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getTaskGrades = async (req, res) => {
  try {
    const tasks = (await kvGet(`tasks:${req.user.id}`)) || [];
    if (!Array.isArray(tasks) || !tasks.some(task => task.id === req.params.taskId)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const grades = (await kvGet(`task_grades:${req.params.taskId}`)) || {};
    return res.json({ grades });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const saveGrades = async (req, res) => {
  try {
    const user = req.user;
    const { grades } = req.body;
    if (!Array.isArray(grades)) return res.status(400).json({ error: 'grades array is required' });
    if (grades.some(grade => !grade?.studentEmail || !grade?.assignment)) {
      return res.status(400).json({ error: 'Each grade requires a student email and assignment' });
    }

    const gradesKey = `dental_college_grades:${user.id}`;
    const previousGrades = (await kvGet(gradesKey)) || [];
    const previousList = Array.isArray(previousGrades) ? previousGrades : [];
    const normalizedGrades = grades.map(grade => ({ ...grade, teacherId: user.id }));

    for (const oldGrade of previousList) {
      const studentKey = `student_grades:${oldGrade.studentEmail}`;
      const studentGrades = (await kvGet(studentKey)) || [];
      if (!Array.isArray(studentGrades)) continue;
      const filtered = studentGrades.filter(grade => grade.id !== oldGrade.id);
      if (filtered.length !== studentGrades.length) await kvSet(studentKey, filtered);
    }

    await kvSet(gradesKey, normalizedGrades);
    for (const grade of normalizedGrades) {
      const studentKey = `student_grades:${grade.studentEmail}`;
      const stored = (await kvGet(studentKey)) || [];
      const studentGrades = Array.isArray(stored) ? stored : [];
      const existingIndex = studentGrades.findIndex(item => item.id === grade.id);
      if (existingIndex >= 0) studentGrades[existingIndex] = grade;
      else studentGrades.push(grade);
      await kvSet(studentKey, studentGrades);

      if (grade.taskId) {
        const taskGradesKey = `task_grades:${grade.taskId}`;
        const taskGrades = (await kvGet(taskGradesKey)) || {};
        await kvSet(taskGradesKey, { ...taskGrades, [grade.studentEmail]: grade.grade ?? grade.score });
        const tasksKey = `student_tasks:${grade.studentEmail}`;
        const studentTasks = (await kvGet(tasksKey)) || [];
        if (Array.isArray(studentTasks)) {
          await kvSet(tasksKey, studentTasks.map(task =>
            task.id === grade.taskId
              ? { ...task, completed: true, grade: grade.grade ?? grade.score, score: grade.score }
              : task
          ));
        }
      }
    }

    return res.json({ success: true, grades: normalizedGrades });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getAllStudents = async (req, res) => {
  try {
    const user = req.user;
    const supabase = getSupabaseClient(true);
    const users = [];
    for (let page = 1; ; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      users.push(...(data?.users || []));
      if (!data?.users || data.users.length < 1000) break;
    }
    const students = users.filter(u => u.user_metadata?.role === 'student');
    const profileEntries = await kvGetByPrefix('student_profile:');
    const profileMap = new Map();
    for (const entry of profileEntries) {
      if (entry.value?.email) profileMap.set(entry.value.email, entry.value);
    }
    const teacherStudents = (await kvGet(`students:${user.id}`)) || [];
    const assignedEmails = new Set(Array.isArray(teacherStudents) ? teacherStudents.map(s => s.email) : []);
    const result = students.map(u => {
      const profile = profileMap.get(u.email) || {};
      const meta = u.user_metadata || {};
      const name = profile.name || meta.name || u.email?.split('@')[0] || 'Student';
      return {
        id: u.id, name, email: u.email,
        avatar: name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
        username: profile.username || meta.username || '',
        rollNumber: profile.rollNumber || meta.rollNumber || '',
        batch: profile.batch || meta.batch || '',
        currentLevel: profile.currentLevel || 1,
        totalPoints: profile.totalPoints || 0,
        gameProgress: profile.gameProgress || 0,
        lastActive: u.last_sign_in_at || u.created_at,
        status: 'active',
        subjects: profile.subjects || [],
        averageGrade: 0,
        classId: profile.classId || null,
        className: profile.className || meta.class || null,
        isRegistered: true,
        isAssigned: assignedEmails.has(u.email),
        registeredAt: u.created_at,
      };
    });
    return res.json({ students: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getTaskStats = async (req, res) => {
  try {
    const user = req.user;
    const [tasks, allStudentsRaw] = await Promise.all([
      kvGet(`tasks:${user.id}`),
      kvGet(`students:${user.id}`),
    ]);
    const tasksList = Array.isArray(tasks) ? tasks : [];
    const allStudents = Array.isArray(allStudentsRaw) ? allStudentsRaw : [];
    const studentEmails = [...new Set(allStudents.map(student => student.email).filter(Boolean))];
    const [taskGradeMaps, studentTaskLists] = await Promise.all([
      runWithConcurrency(tasksList, 20, task => kvGet(`task_grades:${task.id}`)),
      runWithConcurrency(studentEmails, 20, email => kvGet(`student_tasks:${email}`)),
    ]);
    const taskGradesById = new Map(tasksList.map((task, index) => [task.id, taskGradeMaps[index] || {}]));
    const completedTaskIdsByEmail = new Map(studentEmails.map((email, index) => [
      email,
      new Set(Array.isArray(studentTaskLists[index])
        ? studentTaskLists[index].filter(studentTask => studentTask.completed).map(studentTask => studentTask.id)
        : []),
    ]));
    const taskStats = {};
    for (const task of tasksList) {
      const relevantStudents = task.classId ? allStudents.filter(s => s.classId === task.classId) : allStudents;
      const totalStudents = relevantStudents.length;
      let completed = 0;
      const taskGrades = taskGradesById.get(task.id);
      for (const student of relevantStudents) {
        const hasGrade = taskGrades[student.email] !== undefined && taskGrades[student.email] !== null;
        const taskWasCompleted = completedTaskIdsByEmail.get(student.email)?.has(task.id);
        if (hasGrade || taskWasCompleted) completed++;
      }
      taskStats[task.id] = { totalStudents, completed, attempted: completed, completionRate: totalStudents > 0 ? Math.round((completed / totalStudents) * 100) : 0, attemptRate: totalStudents > 0 ? Math.round((completed / totalStudents) * 100) : 0 };
    }
    return res.json({ taskStats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const user = req.user;
    const allowedFields = [
      'name', 'phone', 'department', 'specialization', 'qualification',
      'experience', 'bio', 'address', 'joinDate', 'notifications', 'preferences',
    ];
    const updates = Object.fromEntries(
      allowedFields.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]])
    );
    const supabase = getSupabaseClient(true);
    const profile = { ...user.user_metadata, ...updates };
    const { error } = await supabase.auth.admin.updateUserById(user.id, { user_metadata: profile });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deactivateAccount = async (req, res) => {
  try {
    const user = req.user;
    const supabase = getSupabaseClient(true);
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, accountDisabled: true },
    });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const user = req.user;
    const tasksKey = `tasks:${user.id}`;
    const ownedTasks = (await kvGet(tasksKey)) || [];
    const taskIds = new Set(Array.isArray(ownedTasks) ? ownedTasks.map(task => task.id) : []);
    const teacherGrades = (await kvGet(`dental_college_grades:${user.id}`)) || [];
    const gradeIds = new Set(Array.isArray(teacherGrades) ? teacherGrades.map(grade => grade.id) : []);
    const assignedStudents = (await kvGet(`students:${user.id}`)) || [];
    const [studentTaskEntries, studentGradeEntries, notificationEntries, taskGradeEntries] = await Promise.all([
      kvGetByPrefix('student_tasks:'),
      kvGetByPrefix('student_grades:'),
      kvGetByPrefix('notifications:'),
      kvGetByPrefix('task_grades:'),
    ]);

    for (const entry of studentTaskEntries) {
      if (!Array.isArray(entry.value)) continue;
      const filtered = entry.value.filter(task => !taskIds.has(task.id));
      if (filtered.length !== entry.value.length) await kvSet(entry.key, filtered);
    }
    for (const entry of studentGradeEntries) {
      if (!Array.isArray(entry.value)) continue;
      const filtered = entry.value.filter(grade =>
        grade.teacherId !== user.id
        && !gradeIds.has(grade.id)
        && !taskIds.has(grade.taskId || grade.task_id)
      );
      if (filtered.length !== entry.value.length) await kvSet(entry.key, filtered);
    }
    for (const entry of notificationEntries) {
      if (!Array.isArray(entry.value)) continue;
      const filtered = entry.value.filter(notification => !taskIds.has(notification.taskId));
      if (filtered.length !== entry.value.length) await kvSet(entry.key, filtered);
    }
    for (const entry of taskGradeEntries) {
      if (entry.key.startsWith('task_grades:') && taskIds.has(entry.key.slice('task_grades:'.length))) {
        await kvDelete(entry.key);
      }
    }
    for (const student of Array.isArray(assignedStudents) ? assignedStudents : []) {
      if (!student.email) continue;
      const profileKey = `student_profile:${student.email}`;
      const profile = (await kvGet(profileKey)) || {};
      if (profile.classId === student.classId) {
        await kvSet(profileKey, { ...profile, classId: null, className: null });
      }
    }

    await Promise.all([
      kvDelete(tasksKey),
      kvDelete(`classes:${user.id}`),
      kvDelete(`students:${user.id}`),
      kvDelete(`dental_college_grades:${user.id}`),
    ]);

    const supabase = getSupabaseClient(true);
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getStudentStreak = async (req, res) => {
  try {
    const streakData = (await kvGet(`student_streak:${req.params.email}`)) || { currentStreak: 0, longestStreak: 0, dates: [] };
    return res.json({ streakData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getStudentTasks = async (req, res) => {
  try {
    const tasks = (await kvGet(`student_tasks:${req.params.email}`)) || [];
    return res.json({ tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const assignStudent = async (req, res) => {
  try {
    const user = req.user;
    const { studentId, studentEmail, classId, className } = req.body;
    if (!studentEmail || !classId) return res.status(400).json({ error: 'studentEmail and classId are required' });
    const supabase = getSupabaseClient(true);
    const { data: authData } = await supabase.auth.admin.getUserById(studentId);
    const studentName = authData?.user?.user_metadata?.name || studentEmail.split('@')[0];
    const avatar = studentName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const studentsKey = `students:${user.id}`;
    const existingStudents = (await kvGet(studentsKey)) || [];
    const studentsList = Array.isArray(existingStudents) ? existingStudents : [];
    const existingIndex = studentsList.findIndex(s => s.email === studentEmail || s.id === studentId);
    const studentEntry = { id: studentId, name: studentName, email: studentEmail, avatar, classId, className, status: 'active', addedAt: new Date().toISOString() };
    if (existingIndex >= 0) { studentsList[existingIndex] = { ...studentsList[existingIndex], classId, className }; } 
    else { studentsList.push(studentEntry); }
    await kvSet(studentsKey, studentsList);
    const profileKey = `student_profile:${studentEmail}`;
    const existingProfile = (await kvGet(profileKey)) || {};
    await kvSet(profileKey, { ...existingProfile, classId, className, email: studentEmail });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const unassignStudent = async (req, res) => {
  try {
    const user = req.user;
    const { studentId } = req.body;
    const studentsKey = `students:${user.id}`;
    const existingStudents = (await kvGet(studentsKey)) || [];
    const studentsList = Array.isArray(existingStudents) ? existingStudents : [];
    const student = studentsList.find(s => s.id === studentId);
    const updated = studentsList.filter(s => s.id !== studentId);
    await kvSet(studentsKey, updated);
    if (student?.email) {
      const profileKey = `student_profile:${student.email}`;
      const existingProfile = (await kvGet(profileKey)) || {};
      await kvSet(profileKey, { ...existingProfile, classId: null, className: null });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const batchStudentData = async (req, res) => {
  try {
    const { emails, studentEmails } = req.body;
    const requestedEmails = emails || studentEmails;
    if (!Array.isArray(requestedEmails)) return res.status(400).json({ error: 'emails array required' });
    const results = {};
    for (const email of requestedEmails) {
      const streak = (await kvGet(`student_streak:${email}`)) || { currentStreak: 0, longestStreak: 0, dates: [] };
      const tasks = (await kvGet(`student_tasks:${email}`)) || [];
      const grades = (await kvGet(`student_grades:${email}`)) || [];
      results[email] = {
        streak,
        streakData: streak,
        taskCount: Array.isArray(tasks) ? tasks.length : 0,
        completedCount: Array.isArray(tasks) ? tasks.filter(t => t.completed).length : 0,
        taskData: {
          totalCount: Array.isArray(tasks) ? tasks.length : 0,
          completedCount: Array.isArray(tasks) ? tasks.filter(t => t.completed).length : 0,
        },
        grades,
      };
    }
    return res.json({ students: results, studentsData: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const saveSingleTaskGrade = async (req, res) => {
  try {
    const user = req.user;
    const { taskId, studentEmail, grade } = req.body;
    if (!taskId || !studentEmail || grade === undefined) return res.status(400).json({ error: 'Missing fields' });
    const allTasks = (await kvGet(`tasks:${user.id}`)) || [];
    const task = Array.isArray(allTasks) ? allTasks.find(t => t.id === taskId) : null;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const assignedStudents = (await kvGet(`students:${user.id}`)) || [];
    const student = Array.isArray(assignedStudents)
      ? assignedStudents.find(item => item.email === studentEmail)
      : null;
    if (!student || (task.classId && student.classId !== task.classId)) {
      return res.status(404).json({ error: 'Student is not assigned to this teacher' });
    }
    const storedTaskGrades = (await kvGet(`task_grades:${taskId}`)) || {};
    const taskGrades = storedTaskGrades && typeof storedTaskGrades === 'object' && !Array.isArray(storedTaskGrades)
      ? storedTaskGrades
      : {};
    await kvSet(`task_grades:${taskId}`, { ...taskGrades, [studentEmail]: grade });
    const gradeToScore = { 'A+': 100, 'A': 95, 'A-': 90, 'B+': 85, 'B': 80, 'B-': 75, 'C+': 70, 'C': 65, 'C-': 60, 'D': 50, 'F': 0 };
    const parsedScore = Number(grade);
    const numericScore = Number.isFinite(parsedScore) ? parsedScore : (gradeToScore[grade] ?? 0);
    const maxPoints = task?.maxPoints || task?.points || 100;
    const gradeEntry = {
      id: `${taskId}:${studentEmail}`,
      taskId,
      task_id: taskId,
      teacherId: user.id,
      studentId: student.id,
      studentName: student.name,
      studentEmail,
      classId: task.classId,
      className: task.className,
      subject: task.subject || task.className || 'General',
      assignment: task.title || 'Assignment',
      grade,
      score: numericScore,
      maxScore: 100,
      maxPoints,
      date: new Date().toISOString().split('T')[0],
      gradedAt: new Date().toISOString(),
    };
    const studentGradesKey = `student_grades:${studentEmail}`;
    const studentGrades = (await kvGet(studentGradesKey)) || [];
    const studentGradesList = Array.isArray(studentGrades) ? studentGrades : [];
    const existingIdx = studentGradesList.findIndex(g => g.taskId === taskId || g.task_id === taskId);
    if (existingIdx >= 0) studentGradesList[existingIdx] = gradeEntry;
    else studentGradesList.push(gradeEntry);
    await kvSet(studentGradesKey, studentGradesList);
    const teacherGradesKey = `dental_college_grades:${user.id}`;
    const storedTeacherGrades = (await kvGet(teacherGradesKey)) || [];
    const teacherGrades = Array.isArray(storedTeacherGrades) ? storedTeacherGrades : [];
    const teacherGradeIndex = teacherGrades.findIndex(item => item.id === gradeEntry.id);
    if (teacherGradeIndex >= 0) teacherGrades[teacherGradeIndex] = gradeEntry;
    else teacherGrades.push(gradeEntry);
    await kvSet(teacherGradesKey, teacherGrades);
    const studentTasksKey = `student_tasks:${studentEmail}`;
    const studentTasks = (await kvGet(studentTasksKey)) || [];
    const updatedTasks = Array.isArray(studentTasks) ? studentTasks.map(t => t.id === taskId ? { ...t, completed: true, grade, score: numericScore } : t) : [];
    await kvSet(studentTasksKey, updatedTasks);
    const notifKey = `notifications:${studentEmail}`;
    const notifs = (await kvGet(notifKey)) || [];
    const notifsList = Array.isArray(notifs) ? notifs : [];
    notifsList.push({ id: `notif-grade-${taskId}-${Date.now()}`, type: 'grade', title: `Grade Assigned: ${grade}`, message: `You received a grade of ${grade} for "${task?.title || 'your assignment'}"`, createdAt: new Date().toISOString(), read: false, taskId });
    await kvSet(notifKey, notifsList);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getProfile, getData, saveStudents, saveClasses, deleteClass, updateManualStudent, createTask, updateTask, deleteTask, addTask, getTaskStudents, getTaskGrades,
  saveGrades, getAllStudents, getTaskStats, updateProfile, deactivateAccount, deleteAccount, getStudentStreak, getStudentTasks, assignStudent,
  unassignStudent, batchStudentData, saveSingleTaskGrade
};
