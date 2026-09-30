const express = require('express');
const router = express.Router();
const teacherController = require('../controllers/teacherController');
const { requireAuth, requireTeacher } = require('../middleware/authMiddleware');

router.use(requireAuth, requireTeacher);

router.get('/profile', teacherController.getProfile);
router.get('/data', teacherController.getData);
router.post('/students', teacherController.saveStudents);
router.post('/classes', teacherController.saveClasses);
router.delete('/classes/:classId', teacherController.deleteClass);
router.put('/students/:studentId', teacherController.updateManualStudent);
router.post('/tasks', teacherController.createTask);
router.put('/tasks/:taskId', teacherController.updateTask);
router.delete('/tasks/:taskId', teacherController.deleteTask);
router.post('/add-task', teacherController.addTask);
router.post('/quest', teacherController.addTask); // Backwards compat
router.post('/task-students', teacherController.getTaskStudents);
router.get('/task-grades/:taskId', teacherController.getTaskGrades);
router.post('/grades', teacherController.saveGrades);
router.get('/all-students', teacherController.getAllStudents);
router.get('/task-stats', teacherController.getTaskStats);
router.post('/profile/update', teacherController.updateProfile);
router.post('/account/deactivate', teacherController.deactivateAccount);
router.delete('/account', teacherController.deleteAccount);
router.get('/student-streak/:email', teacherController.getStudentStreak);
router.get('/student-tasks/:email', teacherController.getStudentTasks);
router.post('/assign-student', teacherController.assignStudent);
router.post('/unassign-student', teacherController.unassignStudent);
router.post('/students-batch-data', teacherController.batchStudentData);
router.post('/task-grade', teacherController.saveSingleTaskGrade);

module.exports = router;
