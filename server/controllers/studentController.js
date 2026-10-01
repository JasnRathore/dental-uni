const { kvGet, kvSet, kvGetByPrefix, getSupabaseClient } = require('../../database/services/dbService');
const { trackStudentActivity } = require('../services/studentService');

const getProfile = async (req, res) => {
  try {
    const user = req.user;
    const role = user.user_metadata?.role;
    if (role === 'teacher') return res.status(403).json({ error: 'Access denied. Not a student account.' });
    const name = user.user_metadata?.name || user.email?.split('@')[0] || 'Student';
    const meta = user.user_metadata || {};
    const profile = (await kvGet(`student_profile:${user.email}`)) || {};
    return res.json({
      student: {
        ...profile,
        id: user.id,
        name: profile.name || name,
        email: user.email,
        avatar: (profile.name || name).split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
        role: 'student',
        username: profile.username || meta.username || '',
        rollNumber: profile.rollNumber || meta.rollNumber || '',
        batch: profile.batch || meta.batch || '',
        currentLevel: profile.currentLevel || 1,
        totalPoints: profile.totalPoints || 0,
        gameProgress: profile.gameProgress || 0,
        classId: profile.classId || null,
        className: profile.className || meta.class || null,
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getData = async (req, res) => {
  try {
    const user = req.user;
    const allTasks = (await kvGet(`student_tasks:${user.email}`)) || [];
    const allGrades = (await kvGet(`student_grades:${user.email}`)) || [];
    const streakData = (await kvGet(`student_streak:${user.email}`)) || { currentStreak: 0, longestStreak: 0, dates: [] };
    const tasksList = Array.isArray(allTasks) ? allTasks : [];
    const gradesList = Array.isArray(allGrades) ? allGrades : [];
    const tasksWithCompletion = tasksList.map(task => {
      const hasGrade = gradesList.some(g => g.taskId === task.id || g.task_id === task.id);
      return { ...task, completed: task.completed || hasGrade, grade: gradesList.find(g => g.taskId === task.id || g.task_id === task.id)?.grade };
    });
    const profile = (await kvGet(`student_profile:${user.email}`)) || {};
    const assignedClass = profile.classId ? { id: profile.classId, name: profile.className || '' } : null;
    return res.json({ tasks: tasksWithCompletion, grades: gradesList, streakData, assignedClass, adminMessage: profile.adminMessage || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getDashboard = async (req, res) => {
  try {
    const user = req.user;
    const tasks = (await kvGet(`student_tasks:${user.email}`)) || [];
    const streak = (await kvGet(`student_streak:${user.email}`)) || { currentStreak: 0, dates: [] };
    const profile = (await kvGet(`student_profile:${user.email}`)) || { totalPoints: 0, currentLevel: 1 };
    const pendingTasks = Array.isArray(tasks) ? tasks.filter(task => !task.completed) : [];
    return res.json({ tasks, streak, quest: pendingTasks[0] || null, profile });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const currentProfile = (await kvGet(`student_profile:${req.user.email}`)) || {};
    const classId = currentProfile.classId || null;
    const currentMetadata = req.user.user_metadata || {};
    const className = currentProfile.className || currentMetadata.class ||
      currentProfile.batch || currentMetadata.batch || null;
    const normalizeClassName = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!classId && !className) {
      return res.json({ leaderboard: [], classId: null, className, isAssigned: false });
    }

    const supabase = getSupabaseClient(true);
    const users = [];
    for (let page = 1; ; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      users.push(...(data?.users || []));
      if (!data?.users || data.users.length < 1000) break;
    }

    const [profileEntries, gradeEntries] = await Promise.all([
      kvGetByPrefix('student_profile:'),
      kvGetByPrefix('student_grades:'),
    ]);
    const profilesByEmail = new Map(
      profileEntries
        .filter(entry => entry.value?.email)
        .map(entry => [entry.value.email.toLowerCase(), entry.value])
    );
    const gradesByEmail = new Map(
      gradeEntries.map(entry => [
        entry.key.slice('student_grades:'.length).toLowerCase(),
        Array.isArray(entry.value) ? entry.value : [],
      ])
    );
    const gradePoints = {
      'A+': 100, A: 95, 'A-': 90, 'B+': 85, B: 80, 'B-': 75,
      'C+': 70, C: 65, 'C-': 60, D: 50, F: 0,
    };
    const leaderboard = users
      .filter(user => user.user_metadata?.role === 'student' && user.email)
      .map(user => {
        const emailKey = user.email.toLowerCase();
        const profile = profilesByEmail.get(emailKey) || {};
        const metadata = user.user_metadata || {};
        const studentClassId = profile.classId || null;
        const studentClassName = profile.className || metadata.class || profile.batch || metadata.batch || null;
        const isInClass = classId && studentClassId
          ? String(studentClassId) === String(classId)
          : normalizeClassName(studentClassName) === normalizeClassName(className);
        if (!isInClass) return null;
        const name = profile.name || metadata.name || user.email.split('@')[0] || 'Student';
        const totalEXP = (gradesByEmail.get(emailKey) || []).reduce((total, grade) => {
          if (grade.score != null && grade.maxScore != null && grade.maxScore > 0) {
            const percentage = (grade.score / grade.maxScore) * 100;
            const bonus = percentage >= 95 ? 15 : percentage >= 90 ? 10 : percentage >= 80 ? 5 : 0;
            return total + Math.floor(percentage) + bonus;
          }
          if (grade.grade) return total + (gradePoints[grade.grade] || 0);
          return total;
        }, 0);
        return {
          id: user.id,
          name,
          xp: totalEXP,
          level: Math.floor(totalEXP / 500) + 1,
          isCurrentStudent: user.id === req.user.id,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    return res.json({ leaderboard, classId, className, isAssigned: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getNotifications = async (req, res) => {
  try {
    const user = req.user;
    const notifs = (await kvGet(`notifications:${user.email}`)) || [];
    return res.json({ notifications: notifs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    const user = req.user;
    const { notificationId } = req.body;
    const key = `notifications:${user.email}`;
    const notifs = (await kvGet(key)) || [];
    const updated = Array.isArray(notifs) ? notifs.map(n => n.id === notificationId ? { ...n, read: true } : n) : [];
    await kvSet(key, updated);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const user = req.user;
    if (user.user_metadata?.role !== 'student') {
      return res.status(403).json({ error: 'Only student accounts can update this profile' });
    }
    const profileKey = `student_profile:${user.email}`;
    const existing = (await kvGet(profileKey)) || {};
    const allowedFields = [
      'name', 'username', 'rollNumber', 'batch', 'phone', 'department', 'semester',
      'specialization', 'qualification', 'joinDate', 'address', 'bio',
    ];
    const profileUpdates = Object.fromEntries(
      allowedFields.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]])
    );
    const updatedProfile = { ...existing, ...profileUpdates, email: user.email };
    await kvSet(profileKey, updatedProfile);
    if (profileUpdates.name) {
      const supabase = getSupabaseClient(true);
      const { error } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, name: profileUpdates.name },
      });
      if (error) throw error;
    }
    return res.json({ success: true, profile: updatedProfile });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const submitQuiz = async (req, res) => {
  try {
    const user = req.user;
    const { taskId, score, maxScore, answers } = req.body;

    const gradeEntry = {
      taskId, task_id: taskId,
      studentEmail: user.email,
      subject: 'Quiz',
      assignment: 'Quiz',
      grade: score,
      score,
      maxScore: maxScore || 100,
      date: new Date().toISOString().split('T')[0],
      answers,
    };

    const studentGradesKey = `student_grades:${user.email}`;
    const studentGrades = (await kvGet(studentGradesKey)) || [];
    const gradesList = Array.isArray(studentGrades) ? studentGrades : [];
    const existingIndex = gradesList.findIndex(g => g.taskId === taskId || g.task_id === taskId);
    if (existingIndex >= 0) gradesList[existingIndex] = gradeEntry;
    else gradesList.push(gradeEntry);
    await kvSet(studentGradesKey, gradesList);

    const studentTasksKey = `student_tasks:${user.email}`;
    const studentTasks = (await kvGet(studentTasksKey)) || [];
    const updatedTasks = Array.isArray(studentTasks) ? studentTasks.map(t => t.id === taskId ? { ...t, completed: true, grade: score } : t) : [];
    await kvSet(studentTasksKey, updatedTasks);

    await trackStudentActivity(user.email);

    const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
    const notifKey = `notifications:${user.email}`;
    const notifs = (await kvGet(notifKey)) || [];
    const notifsList = Array.isArray(notifs) ? notifs : [];
    notifsList.push({
      id: `notif-${Date.now()}`,
      type: 'grade',
      title: `Quiz Submitted!`,
      message: `You scored ${score}/${maxScore} points (${percentage}%)`,
      createdAt: new Date().toISOString(),
      read: false,
    });
    await kvSet(notifKey, notifsList);

    return res.json({ success: true, percentage });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getQuest = async (req, res) => {
  try {
    const user = req.user;
    const tasks = (await kvGet(`student_tasks:${user.email}`)) || [];
    const tasksList = Array.isArray(tasks) ? tasks : [];
    const pending = tasksList.filter(t => !t.completed);
    return res.json({ quest: pending[0] || null, tasks: tasksList });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getProfile,
  getData,
  getDashboard,
  getLeaderboard,
  getNotifications,
  markNotificationRead,
  updateProfile,
  submitQuiz,
  getQuest
};
