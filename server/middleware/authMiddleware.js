const { getSupabaseClient } = require('../../database/services/dbService');

const getUser = async (authHeader) => {
  const accessToken = authHeader?.split(' ')[1];
  if (!accessToken) return null;
  const supabase = getSupabaseClient(true);
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) return null;
  return user;
};

const requireAuth = async (req, res, next) => {
  try {
    const user = await getUser(req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (user.app_metadata?.accountDisabled) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const requireTeacher = (req, res, next) => {
  if (req.user?.user_metadata?.role === 'student') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  return next();
};

const requireStudent = (req, res, next) => {
  if (req.user?.user_metadata?.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  return next();
};

module.exports = {
  getUser,
  requireAuth,
  requireTeacher,
  requireStudent
};
