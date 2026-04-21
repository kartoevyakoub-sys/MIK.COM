// Функция отрисовки расписания
function renderSchedule(data) {
  const container = document.getElementById('scheduleContainer');
  container.innerHTML = ''; // очищаем контейнер

  data.weeks.forEach(week => {
    // Создаём блок недели
    const weekDiv = document.createElement('div');
    weekDiv.classList.add('week');

    // Заголовок недели
    const weekTitle = document.createElement('div');
    weekTitle.classList.add('week-title');
    weekTitle.textContent = `${week.weekNumber} НЕДЕЛЯ`;
    weekDiv.appendChild(weekTitle);

    // Дни недели
    week.days.forEach(day => {
      const dayCard = document.createElement('div');
      dayCard.classList.add('day-card');

      const dayHeader = document.createElement('div');
      dayHeader.classList.add('day-header');
      dayHeader.textContent = day.name;
      dayCard.appendChild(dayHeader);

      const dayContent = document.createElement('div');
      dayContent.classList.add('day-content');

      // Если есть сообщение об отсутствии занятий
      if (day.emptyMessage) {
        const emptyDiv = document.createElement('div');
        emptyDiv.classList.add('online');
        emptyDiv.textContent = day.emptyMessage;
        dayContent.appendChild(emptyDiv);
      } 
      // Если есть уроки
      else if (day.lessons && day.lessons.length) {
        day.lessons.forEach(lesson => {
          const lessonDiv = document.createElement('div');
          lessonDiv.classList.add('lesson');

          const infoDiv = document.createElement('div');
          infoDiv.classList.add('lesson-info');

          const numberDiv = document.createElement('div');
          numberDiv.classList.add('lesson-number');
          numberDiv.textContent = `${lesson.number}) ${lesson.subject}`;
          infoDiv.appendChild(numberDiv);

          // Тип занятия (если указан)
          if (lesson.type && lesson.type !== null) {
            const typeDiv = document.createElement('div');
            typeDiv.classList.add('lesson-name');
            typeDiv.textContent = lesson.type;
            infoDiv.appendChild(typeDiv);
          }

          const teacherDiv = document.createElement('div');
          teacherDiv.classList.add('teacher');
          teacherDiv.textContent = lesson.teacher;
          infoDiv.appendChild(teacherDiv);

          const roomDiv = document.createElement('div');
          roomDiv.classList.add('classroom');
          roomDiv.textContent = lesson.room;

          lessonDiv.appendChild(infoDiv);
          lessonDiv.appendChild(roomDiv);
          dayContent.appendChild(lessonDiv);
        });
      }

      dayCard.appendChild(dayContent);
      weekDiv.appendChild(dayCard);
    });

    container.appendChild(weekDiv);
  });

  // После отрисовки — заново инициализируем анимацию при скролле
  const animatedItems = document.querySelectorAll('.week-title, .day-card');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('show');
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -5% 0px' });
  animatedItems.forEach(el => io.observe(el));
}

// Загрузка данных из schedule.json
fetch('schedule.json')
  .then(response => {
    if (!response.ok) {
      throw new Error(`Ошибка загрузки: ${response.status}`);
    }
    return response.json();
  })
  .then(data => {
    renderSchedule(data);
  })
  .catch(error => {
    console.error('Не удалось загрузить расписание:', error);
    document.getElementById('scheduleContainer').innerHTML = 
      '<p style="color: red; text-align: center; padding: 40px;">❌ Не удалось загрузить расписание. Убедитесь, что файл schedule.json существует и запущен через локальный сервер (Live Server).</p>';
  });

// Переключение темы
const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', () => {
  document.body.classList.toggle('light');
  document.body.classList.toggle('dark');
  themeBtn.textContent = document.body.classList.contains('light') ? '🌙' : '☀️';
});